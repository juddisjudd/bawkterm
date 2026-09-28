import { shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp, unwatchFile, watchFile, type Stats as FsStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { EditInfo, EditState } from '@shared/types'
import type { Prompter, Send } from '../prompts'
import type { Vault } from '../vault'

const MAX_BYTES = 20 * 1024 * 1024
const POLL_MS = 700

interface Edit {
  sessionId: string
  remotePath: string
  dir: string
  localPath: string
  mtime: number
  size: number
  lastLocal: number
  uploading: boolean
  again: boolean
  pending: boolean
}

function call<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))))
}

let codeOnPath: Promise<boolean> | undefined
function hasVsCode(): Promise<boolean> {
  codeOnPath ??= new Promise((resolve) =>
    execFile(process.platform === 'win32' ? 'where' : 'which', ['code'], (err) => resolve(!err))
  )
  return codeOnPath
}

async function openInEditor(path: string, command: string): Promise<void> {
  const cmd = command.trim() || ((await hasVsCode()) ? 'code' : '')
  if (!cmd) {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return
  }
  spawn(`${cmd} "${path}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

export class RemoteEditor {
  private edits = new Map<string, Edit>()

  constructor(
    private sftpFor: (sessionId: string) => SFTPWrapper,
    private prompter: Prompter,
    private send: Send,
    private vault: Vault
  ) {}

  private key(sessionId: string, remotePath: string): string {
    return `${sessionId}\n${remotePath}`
  }

  private emit(edit: Pick<Edit, 'sessionId' | 'remotePath'>, state: EditState, message?: string): void {
    const info: EditInfo = {
      sessionId: edit.sessionId,
      remotePath: edit.remotePath,
      name: posix.basename(edit.remotePath),
      state,
      message,
      at: Date.now()
    }
    this.send('sftp:edit', info)
  }

  async open(sessionId: string, remotePath: string): Promise<void> {
    const editor = this.vault.get().settings.editorCommand
    const existing = this.edits.get(this.key(sessionId, remotePath))
    if (existing) {
      await openInEditor(existing.localPath, editor)
      return
    }
    const sftp = this.sftpFor(sessionId)
    const st = await call<Stats>((cb) => sftp.stat(remotePath, cb))
    if (st.isDirectory()) throw new Error('Folders cannot be opened in an editor')
    if (st.size > MAX_BYTES) throw new Error('This file is larger than 20 MB, download it instead')

    const data = await call<Buffer>((cb) => sftp.readFile(remotePath, cb))
    const dir = join(tmpdir(), 'bawkterm-edit', randomUUID())
    await fsp.mkdir(dir, { recursive: true })
    const safeName = posix.basename(remotePath).replace(/[^\w.-]/g, '_') || 'file'
    const localPath = join(dir, safeName)
    await fsp.writeFile(localPath, data)

    const edit: Edit = {
      sessionId,
      remotePath,
      dir,
      localPath,
      mtime: st.mtime,
      size: st.size,
      lastLocal: (await fsp.stat(localPath)).mtimeMs,
      uploading: false,
      again: false,
      pending: false
    }
    this.edits.set(this.key(sessionId, remotePath), edit)
    watchFile(localPath, { interval: POLL_MS }, (curr: FsStats) => {
      if (!curr.mtimeMs || curr.mtimeMs === edit.lastLocal) return
      edit.lastLocal = curr.mtimeMs
      void this.upload(edit)
    })
    this.emit(edit, 'open')
    await openInEditor(localPath, editor)
  }

  private async upload(edit: Edit): Promise<void> {
    if (edit.uploading) {
      edit.again = true
      return
    }
    edit.uploading = true
    this.emit(edit, 'uploading')
    try {
      const sftp = this.sftpFor(edit.sessionId)
      const remote = await call<Stats>((cb) => sftp.stat(edit.remotePath, cb))
      if (remote.mtime !== edit.mtime || remote.size !== edit.size) {
        const answer = await this.prompter.forSession(edit.sessionId)({
          kind: 'confirm',
          title: 'Remote file changed',
          message: `${edit.remotePath} changed on the server after you opened it. Upload your version and replace it?`,
          fields: [],
          confirmLabel: 'Replace',
          danger: true
        })
        if (!answer) {
          this.emit(edit, 'error', 'Not uploaded: the server copy changed')
          return
        }
      }
      const data = await fsp.readFile(edit.localPath)
      await call((cb) => sftp.writeFile(edit.remotePath, data, cb))
      const after = await call<Stats>((cb) => sftp.stat(edit.remotePath, cb))
      edit.mtime = after.mtime
      edit.size = after.size
      edit.pending = false
      this.emit(edit, 'uploaded')
    } catch (err) {
      edit.pending = true
      this.emit(edit, 'error', `Not uploaded yet: ${(err as Error).message}`)
    } finally {
      edit.uploading = false
      if (edit.again) {
        edit.again = false
        void this.upload(edit)
      }
    }
  }

  async stop(sessionId: string, remotePath: string): Promise<void> {
    const key = this.key(sessionId, remotePath)
    const edit = this.edits.get(key)
    if (!edit) return
    this.edits.delete(key)
    unwatchFile(edit.localPath)
    await fsp.rm(edit.dir, { recursive: true, force: true }).catch(() => {})
    this.emit(edit, 'closed')
  }

  resume(sessionId: string): void {
    for (const edit of this.edits.values()) {
      if (edit.sessionId === sessionId && edit.pending) void this.upload(edit)
    }
  }

  stopSession(sessionId: string): void {
    for (const edit of [...this.edits.values()]) {
      if (edit.sessionId === sessionId) void this.stop(sessionId, edit.remotePath)
    }
  }
}
