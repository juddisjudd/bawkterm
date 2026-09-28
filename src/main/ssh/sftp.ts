import { promises as fsp } from 'node:fs'
import path, { basename, join } from 'node:path'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { ConnectTarget, FileEntry, SessionEvent, TransferDirection, TransferInfo } from '@shared/types'
import type { Prompter, Send } from '../prompts'
import type { Vault } from '../vault'
import { CancelledError, closeConnection, connect, type Connection } from './connect'
import { RemoteEditor } from './remote-edit'

const CHUNK = 32 * 1024
const PARALLEL = 32
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

type Policy = 'replace' | 'rename' | 'skip'

interface Batch {
  policy?: Policy
}

interface Job {
  info: TransferInfo
  cancelled: boolean
  batch: Batch
  run: (job: Job) => Promise<void>
}

class SkippedError extends Error {}

type Exists = (target: string) => Promise<'file' | 'dir' | null>

interface Session {
  id: string
  abort: AbortController
  conn?: Connection
  sftp?: SFTPWrapper
  queue: Job[]
  running: boolean
  closed: boolean
  userClosed?: boolean
}

interface Planned {
  dirs: string[]
  files: { src: string; dest: string; size: number }[]
}

function call<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))))
}

const isDir = (mode: number): boolean => (mode & S_IFMT) === S_IFDIR
const isLink = (mode: number): boolean => (mode & S_IFMT) === S_IFLNK

async function pump(size: number, work: (pos: number, len: number) => Promise<void>, job: Job): Promise<void> {
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    try {
      while (!failed && next < size) {
        if (job.cancelled) throw new CancelledError()
        const pos = next
        const len = Math.min(CHUNK, size - pos)
        next += len
        await work(pos, len)
      }
    } catch (err) {
      failed = true
      throw err
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(PARALLEL, Math.ceil(size / CHUNK)) }, worker)
  )
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected) throw rejected.reason
}

export class SftpSessions {
  private sessions = new Map<string, Session>()
  readonly editor: RemoteEditor
  private jobs = new Map<string, Job>()
  private lastEmit = new Map<string, number>()

  constructor(
    private vault: Vault,
    private prompter: Prompter,
    private send: Send
  ) {
    this.editor = new RemoteEditor((id) => this.get(id), prompter, send, vault)
  }

  private status(sessionId: string, status: SessionEvent['status'], message?: string, dropped?: boolean): void {
    const event: SessionEvent = { sessionId, status, message, dropped }
    this.send('sftp:status', event)
  }

  private get(sessionId: string): SFTPWrapper {
    const sftp = this.sessions.get(sessionId)?.sftp
    if (!sftp) throw new Error('SFTP session is not connected')
    return sftp
  }

  async open(sessionId: string, target: ConnectTarget): Promise<{ home: string; title: string }> {
    this.close(sessionId)
    const session: Session = { id: sessionId, abort: new AbortController(), queue: [], running: false, closed: false }
    this.sessions.set(sessionId, session)
    this.status(sessionId, 'connecting')
    try {
      session.conn = await connect(target, {
        vault: this.vault,
        ask: this.prompter.forSession(sessionId),
        signal: session.abort.signal,
        onProgress: (message) => this.status(sessionId, 'connecting', message)
      })
      session.sftp = await call<SFTPWrapper>((cb) => session.conn!.client.sftp(cb))
    } catch (err) {
      if (session.conn) closeConnection(session.conn)
      this.sessions.delete(sessionId)
      const message = err instanceof CancelledError ? 'Cancelled' : (err as Error).message
      this.status(sessionId, err instanceof CancelledError ? 'closed' : 'error', message)
      throw new Error(message)
    }
    const { conn, sftp } = session
    conn.client.on('close', () => this.finish(session, 'Connection lost'))
    sftp.on('close', () => this.finish(session, 'SFTP channel closed'))
    const home = await call<string>((cb) => sftp.realpath('.', cb)).catch(() => '/')
    this.status(sessionId, 'connected')
    this.editor.resume(sessionId)
    return { home, title: conn.label }
  }

  private finish(session: Session, message: string): void {
    if (session.closed) return
    session.closed = true
    const dropped = !session.userClosed
    // edits survive a drop and upload again once the tab reconnects
    if (!dropped) this.editor.stopSession(session.id)
    this.sessions.delete(session.id)
    for (const job of session.queue) this.cancel(job.info.id)
    if (session.conn) closeConnection(session.conn)
    this.status(session.id, 'closed', message, dropped)
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.userClosed = true
    this.prompter.cancelSession(sessionId)
    session.abort.abort()
    this.finish(session, 'Closed')
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  async list(sessionId: string, dir: string): Promise<FileEntry[]> {
    const sftp = this.get(sessionId)
    const items = await call<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(dir, cb))
    return Promise.all(
      items
        .filter((i) => i.filename !== '.' && i.filename !== '..')
        .map(async ({ filename, attrs }) => {
          const path = posix.join(dir, filename)
          const link = isLink(attrs.mode)
          let linkDir = false
          if (link) {
            linkDir = await call<Stats>((cb) => sftp.stat(path, cb)).then(
              (s) => isDir(s.mode),
              () => false
            )
          }
          const entry: FileEntry = {
            name: filename,
            path,
            kind: link ? 'link' : isDir(attrs.mode) ? 'dir' : 'file',
            linkDir,
            size: attrs.size,
            mtime: attrs.mtime * 1000,
            mode: attrs.mode
          }
          return entry
        })
    )
  }

  async realpath(sessionId: string, path: string): Promise<string> {
    const sftp = this.get(sessionId)
    return call<string>((cb) => sftp.realpath(path, cb))
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = this.get(sessionId)
    await call((cb) => sftp.mkdir(path, cb))
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = this.get(sessionId)
    await call((cb) => sftp.rename(from, to, cb))
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const sftp = this.get(sessionId)
    await call((cb) => sftp.chmod(path, mode, cb))
  }

  async remove(sessionId: string, paths: string[]): Promise<void> {
    const sftp = this.get(sessionId)
    const removeOne = async (path: string): Promise<void> => {
      const st = await call<Stats>((cb) => sftp.lstat(path, cb))
      if (!isDir(st.mode)) {
        await call((cb) => sftp.unlink(path, cb))
        return
      }
      const items = await call<{ filename: string }[]>((cb) => sftp.readdir(path, cb))
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        await removeOne(posix.join(path, item.filename))
      }
      await call((cb) => sftp.rmdir(path, cb))
    }
    for (const path of paths) await removeOne(path)
  }

  upload(sessionId: string, localPaths: string[], remoteDir: string): void {
    const batch: Batch = {}
    for (const src of localPaths) {
      const name = basename(src)
      this.enqueue(sessionId, 'upload', name, src, posix.join(remoteDir, name), batch, (job) => this.runUpload(sessionId, job))
    }
  }

  download(sessionId: string, remotePaths: string[], localDir: string): void {
    const batch: Batch = {}
    for (const src of remotePaths) {
      const name = posix.basename(src)
      this.enqueue(sessionId, 'download', name, src, join(localDir, name), batch, (job) => this.runDownload(sessionId, job))
    }
  }

  private async resolveConflict(sessionId: string, job: Job, exists: Exists, paths: typeof posix): Promise<string> {
    const kind = await exists(job.info.dest)
    if (!kind) return job.info.dest
    let choice = job.batch.policy
    if (!choice) {
      const answer = await this.prompter.forSession(sessionId)({
        kind: 'confirm',
        title: kind === 'dir' ? 'Folder already exists' : 'File already exists',
        message: `"${job.info.name}" already exists in ${paths.dirname(job.info.dest)}.`,
        fields: [],
        confirmLabel: '',
        checkbox: { name: 'all', label: 'Do the same for the rest of this transfer' },
        choices: [
          { id: 'replace', label: kind === 'dir' ? 'Merge' : 'Replace', danger: kind === 'file' },
          { id: 'rename', label: 'Keep both' },
          { id: 'skip', label: 'Skip' }
        ]
      })
      choice = (answer?.choice as Policy | undefined) ?? 'skip'
      if (answer?.checked) job.batch.policy = choice
    }
    if (choice === 'skip') throw new SkippedError()
    if (choice === 'replace') return job.info.dest
    const dir = paths.dirname(job.info.dest)
    const ext = kind === 'file' ? paths.extname(job.info.name) : ''
    const stem = job.info.name.slice(0, job.info.name.length - ext.length)
    for (let n = 1; n < 1000; n++) {
      const candidate = paths.join(dir, `${stem} (${n})${ext}`)
      if (!(await exists(candidate))) return candidate
    }
    throw new Error('No free name found')
  }

  cancel(transferId: string): void {
    const job = this.jobs.get(transferId)
    if (!job) return
    job.cancelled = true
    if (job.info.state === 'queued') {
      job.info.state = 'cancelled'
      this.emit(job, true)
    }
  }

  private enqueue(
    sessionId: string,
    direction: TransferDirection,
    name: string,
    source: string,
    dest: string,
    batch: Batch,
    run: Job['run']
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session?.sftp) throw new Error('SFTP session is not connected')
    const job: Job = {
      info: {
        id: randomUUID(),
        sessionId,
        direction,
        name,
        source,
        dest,
        bytes: 0,
        total: 0,
        files: 0,
        filesDone: 0,
        state: 'queued',
        startedAt: Date.now()
      },
      cancelled: false,
      batch,
      run
    }
    this.jobs.set(job.info.id, job)
    session.queue.push(job)
    this.emit(job, true)
    void this.drain(session)
  }

  private async drain(session: Session): Promise<void> {
    if (session.running) return
    session.running = true
    while (session.queue.length) {
      const job = session.queue.shift()!
      if (job.cancelled) continue
      job.info.state = 'active'
      job.info.startedAt = Date.now()
      this.emit(job, true)
      try {
        await job.run(job)
        job.info.state = 'done'
      } catch (err) {
        job.info.state = err instanceof SkippedError ? 'skipped' : err instanceof CancelledError || job.cancelled ? 'cancelled' : 'error'
        if (job.info.state === 'error') job.info.error = (err as Error).message
      }
      this.emit(job, true)
      this.jobs.delete(job.info.id)
      this.lastEmit.delete(job.info.id)
    }
    session.running = false
  }

  private emit(job: Job, force = false): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(job.info.id) ?? 0) < 120) return
    this.lastEmit.set(job.info.id, now)
    this.send('sftp:transfer', { ...job.info })
  }

  private progress(job: Job, bytes: number): void {
    job.info.bytes += bytes
    this.emit(job)
  }

  private async planLocal(src: string, dest: string): Promise<Planned> {
    const plan: Planned = { dirs: [], files: [] }
    const walk = async (s: string, d: string): Promise<void> => {
      const st = await fsp.stat(s)
      if (!st.isDirectory()) {
        plan.files.push({ src: s, dest: d, size: st.size })
        return
      }
      plan.dirs.push(d)
      for (const name of await fsp.readdir(s)) await walk(join(s, name), posix.join(d, name))
    }
    await walk(src, dest)
    return plan
  }

  private async planRemote(sftp: SFTPWrapper, src: string, dest: string): Promise<Planned> {
    const plan: Planned = { dirs: [], files: [] }
    const walk = async (s: string, d: string): Promise<void> => {
      const st = await call<Stats>((cb) => sftp.stat(s, cb))
      if (!isDir(st.mode)) {
        plan.files.push({ src: s, dest: d, size: st.size })
        return
      }
      plan.dirs.push(d)
      const items = await call<{ filename: string }[]>((cb) => sftp.readdir(s, cb))
      for (const item of items) {
        if (item.filename === '.' || item.filename === '..') continue
        await walk(posix.join(s, item.filename), join(d, item.filename))
      }
    }
    await walk(src, dest)
    return plan
  }

  private async runUpload(sessionId: string, job: Job): Promise<void> {
    const sftp = this.get(sessionId)
    job.info.dest = await this.resolveConflict(
      sessionId,
      job,
      (p) => call<Stats>((cb) => sftp.stat(p, cb)).then((s) => (isDir(s.mode) ? 'dir' : 'file'), () => null),
      posix
    )
    this.emit(job, true)
    const plan = await this.planLocal(job.info.source, job.info.dest)
    job.info.total = plan.files.reduce((n, f) => n + f.size, 0)
    job.info.files = plan.files.length
    this.emit(job, true)

    for (const dir of plan.dirs) {
      const exists = await call<Stats>((cb) => sftp.stat(dir, cb)).then(
        (s) => isDir(s.mode),
        () => false
      )
      if (!exists) await call((cb) => sftp.mkdir(dir, cb))
    }
    for (const file of plan.files) {
      if (job.cancelled) throw new CancelledError()
      await this.uploadFile(sftp, file.src, file.dest, job)
      job.info.filesDone++
    }
  }

  private async uploadFile(sftp: SFTPWrapper, src: string, dest: string, job: Job): Promise<void> {
    const local = await fsp.open(src, 'r')
    let handle: Buffer | undefined
    try {
      const { size } = await local.stat()
      handle = await call<Buffer>((cb) => sftp.open(dest, 'w', cb))
      const remote = handle
      await pump(
        size,
        async (pos, len) => {
          const buf = Buffer.allocUnsafe(len)
          let got = 0
          while (got < len) {
            const { bytesRead } = await local.read(buf, got, len - got, pos + got)
            if (!bytesRead) throw new Error(`${src} changed while uploading`)
            got += bytesRead
          }
          await call((cb) => sftp.write(remote, buf, 0, len, pos, cb))
          this.progress(job, len)
        },
        job
      )
    } catch (err) {
      if (err instanceof CancelledError && handle) {
        await call((cb) => sftp.close(handle!, cb)).catch(() => {})
        handle = undefined
        await call((cb) => sftp.unlink(dest, cb)).catch(() => {})
      }
      throw err
    } finally {
      await local.close()
      if (handle) await call((cb) => sftp.close(handle!, cb)).catch(() => {})
    }
  }

  private async runDownload(sessionId: string, job: Job): Promise<void> {
    const sftp = this.get(sessionId)
    job.info.dest = await this.resolveConflict(
      sessionId,
      job,
      (p) => fsp.stat(p).then((s) => (s.isDirectory() ? 'dir' : 'file'), () => null),
      path as unknown as typeof posix
    )
    this.emit(job, true)
    const plan = await this.planRemote(sftp, job.info.source, job.info.dest)
    job.info.total = plan.files.reduce((n, f) => n + f.size, 0)
    job.info.files = plan.files.length
    this.emit(job, true)

    for (const dir of plan.dirs) await fsp.mkdir(dir, { recursive: true })
    for (const file of plan.files) {
      if (job.cancelled) throw new CancelledError()
      await this.downloadFile(sftp, file.src, file.dest, job)
      job.info.filesDone++
    }
  }

  private async downloadFile(sftp: SFTPWrapper, src: string, dest: string, job: Job): Promise<void> {
    const handle = await call<Buffer>((cb) => sftp.open(src, 'r', cb))
    const local = await fsp.open(dest, 'w')
    try {
      const { size } = await call<Stats>((cb) => sftp.fstat(handle, cb))
      await pump(
        size,
        async (pos, len) => {
          const buf = Buffer.allocUnsafe(len)
          let got = 0
          while (got < len) {
            const n = await call<number>((cb) => sftp.read(handle, buf, got, len - got, pos + got, cb))
            if (!n) throw new Error(`${src} changed while downloading`)
            got += n
          }
          await local.write(buf, 0, len, pos)
          this.progress(job, len)
        },
        job
      )
    } catch (err) {
      if (err instanceof CancelledError) {
        await local.close().catch(() => {})
        await fsp.rm(dest, { force: true })
      }
      throw err
    } finally {
      await local.close().catch(() => {})
      await call((cb) => sftp.close(handle, cb)).catch(() => {})
    }
  }
}
