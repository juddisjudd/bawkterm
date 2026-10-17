import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { DbChange, DbInfo, DbKey, DbPage, DbPageRequest, DbResult, DbCell, SaveResult } from '@shared/types'
import { EDIT_ROOT } from '../ssh/remote-edit'
import { call, readHead, readWhole, writeWhole } from '../ssh/sftp-util'
import workerPath from './worker?modulePath'
import type { DbOps } from './worker'

const MAX_BYTES = 256 * 1024 * 1024
const MAGIC = Buffer.from('SQLite format 3\0')
const HEADER = 100
const TOO_LARGE = 'This database is larger than 256 MB. Download it and open it in a desktop SQLite tool.'
const PERMISSION_DENIED = 3
const OP_UNSUPPORTED = 8

// SQLite raises this header field each time a write commits
const changeCounter = (head: Uint8Array | null): number | null =>
  head && head.length >= 28 ? new DataView(head.buffer, head.byteOffset, head.length).getUint32(24) : null

const sizeOf = (sftp: SFTPWrapper, path: string): Promise<number | null> =>
  call<Stats>((cb) => sftp.stat(path, cb)).then(
    (st) => st.size,
    () => null
  )

interface Beside {
  wal: number | null
  shm: number | null
  journal: number | null
}

async function beside(sftp: SFTPWrapper, path: string): Promise<Beside> {
  const [wal, shm, journal] = await Promise.all(['-wal', '-shm', '-journal'].map((s) => sizeOf(sftp, path + s)))
  return { wal, shm, journal }
}

// a -wal or -shm file means a program has the database open; a non-empty -journal means a write never finished
function busy({ wal, shm, journal }: Beside): string | null {
  if (wal !== null || shm !== null) return 'A program has this database open.'
  if (journal) return 'A write to this database did not finish.'
  return null
}

// a status the server sent back; a dropped connection has none and must not start a write over the original
const refused = (err: unknown): boolean => {
  const code = (err as { code?: unknown }).code
  return code === PERMISSION_DENIED || code === OP_UNSUPPORTED || /does not support/.test((err as Error).message)
}

// a sibling file renamed over the original, so a dropped connection never leaves half a database behind
async function replace(sftp: SFTPWrapper, path: string, data: Uint8Array): Promise<void> {
  const link = await call<Stats>((cb) => sftp.lstat(path, cb)).catch(() => null)
  if (!link || link.isSymbolicLink()) return writeWhole(sftp, path, data)
  const temp = posix.join(posix.dirname(path), `.${posix.basename(path)}.${randomUUID().slice(0, 8)}.tmp`)
  const mode = link.mode & 0o7777
  try {
    await writeWhole(sftp, temp, data, mode)
    await call((cb) => sftp.chmod(temp, mode, cb))
    await call((cb) => sftp.chown(temp, link.uid, link.gid, cb))
    await call((cb) => sftp.ext_openssh_rename(temp, path, cb))
  } catch (err) {
    await call((cb) => sftp.unlink(temp, cb)).catch(() => {})
    if (!refused(err)) throw err
    await writeWhole(sftp, path, data)
  }
}

type Result<K extends keyof DbOps> = ReturnType<DbOps[K]>

// each database lives in its own process: a slow query never stalls terminals, and Stop can kill it even inside SQLite
class Database {
  remote = { path: '', mtime: 0, size: 0, counter: null as number | null }
  readOnly: string | null = null
  private child: UtilityProcess = utilityProcess.fork(workerPath, [], { serviceName: 'bawkterm SQLite' })
  private calls = new Map<number, { resolve: (v: never) => void; reject: (err: Error) => void }>()
  private seq = 0
  private exited = false

  constructor() {
    this.child.on('message', ({ id, value, error }: { id: number; value?: unknown; error?: string }) => {
      const pending = this.calls.get(id)
      this.calls.delete(id)
      if (error === undefined) pending?.resolve(value as never)
      else pending?.reject(new Error(error))
    })
    this.child.on('exit', () => {
      this.exited = true
      for (const pending of this.calls.values()) pending.reject(new Error('The database was closed'))
      this.calls.clear()
    })
  }

  call<K extends keyof DbOps>(op: K, args: Parameters<DbOps[K]>): Promise<Result<K>> {
    if (this.exited) return Promise.reject(new Error('The database was closed'))
    const id = ++this.seq
    return new Promise<Result<K>>((resolve, reject) => {
      this.calls.set(id, { resolve, reject })
      this.child.postMessage({ id, op, args })
    })
  }

  close(): void {
    this.child.kill()
  }
}

export class RemoteDatabases {
  private open = new Map<string, Database>()

  constructor(private sftpFor: (sessionId: string) => SFTPWrapper) {}

  private get(dbId: string): Database {
    const db = this.open.get(dbId)
    if (!db) throw new Error('The database is not open')
    return db
  }

  async load(dbId: string, sessionId: string, path: string): Promise<DbInfo> {
    this.close(dbId)
    const db = new Database()
    this.open.set(dbId, db)
    try {
      const sftp = this.sftpFor(sessionId)
      const st = await call<Stats>((cb) => sftp.stat(path, cb))
      if (st.isDirectory()) throw new Error('Folders cannot be opened as a database')
      if (!st.isFile()) throw new Error('Only regular files can be opened as a database')
      if (st.size > MAX_BYTES) throw new Error(TOO_LARGE)
      const near = await beside(sftp, path)
      const reason = busy(near)
      // the log first: a checkpoint between the two reads then only moves data into the main file
      const wal = near.wal ? await readWhole(sftp, `${path}-wal`, MAX_BYTES, TOO_LARGE) : null
      const journal = !wal && near.journal ? await readWhole(sftp, `${path}-journal`, MAX_BYTES, TOO_LARGE) : null
      const file = await readWhole(sftp, path, MAX_BYTES, TOO_LARGE)
      if (!file.subarray(0, 16).equals(MAGIC)) {
        throw new Error('This file is not a SQLite 3 database. It may be encrypted or in another format.')
      }
      const companion = wal ? { suffix: '-wal', data: wal } : journal ? { suffix: '-journal', data: journal } : null
      const tables = await db.call('load', [file, companion, join(EDIT_ROOT, randomUUID()), !!reason])
      db.remote = { path, mtime: st.mtime, size: st.size, counter: changeCounter(file) }
      db.readOnly = reason && `Read-only. ${reason} Editing it now could corrupt it. Close the program that uses it, then reload.`
      return { tables, size: st.size, readOnly: db.readOnly }
    } catch (err) {
      if (this.open.get(dbId) === db) this.close(dbId)
      throw err
    }
  }

  tables(dbId: string): Promise<DbInfo['tables']> {
    return this.get(dbId).call('tables', [])
  }

  page(dbId: string, req: DbPageRequest): Promise<DbPage> {
    return this.get(dbId).call('page', [req])
  }

  row(dbId: string, table: string, key: DbKey): Promise<DbCell[]> {
    return this.get(dbId).call('row', [table, key])
  }

  private writable(dbId: string): Database {
    const db = this.get(dbId)
    if (db.readOnly) throw new Error(db.readOnly)
    return db
  }

  update(dbId: string, table: string, key: DbKey, changes: DbChange[]): Promise<boolean> {
    return this.writable(dbId).call('update', [table, key, changes])
  }

  insert(dbId: string, table: string, changes: DbChange[]): Promise<boolean> {
    return this.writable(dbId).call('insert', [table, changes])
  }

  remove(dbId: string, table: string, keys: DbKey[]): Promise<boolean> {
    return this.writable(dbId).call('remove', [table, keys])
  }

  query(dbId: string, sql: string): Promise<DbResult> {
    return this.get(dbId).call('query', [sql])
  }

  async save(dbId: string, sessionId: string, force: boolean): Promise<SaveResult> {
    const db = this.writable(dbId)
    const sftp = this.sftpFor(sessionId)
    const { path } = db.remote
    if (!force) {
      const st = await call<Stats>((cb) => sftp.stat(path, cb)).catch(() => null)
      // SFTP times have one-second steps, so a write within that second shows only in SQLite's change counter
      const counter = st && changeCounter(await readHead(sftp, path, HEADER).catch(() => null))
      if (st && (st.mtime !== db.remote.mtime || st.size !== db.remote.size || counter !== db.remote.counter)) {
        return { conflict: true }
      }
    }
    const reason = busy(await beside(sftp, path))
    if (reason) throw new Error(`Not saved. ${reason} Saving now could corrupt it. Close the program that uses it, then save again.`)
    const { bytes, version } = await db.call('image', [])
    await replace(sftp, path, bytes)
    const after = await call<Stats>((cb) => sftp.stat(path, cb))
    db.remote = { path, mtime: after.mtime, size: after.size, counter: changeCounter(bytes) }
    await db.call('markSaved', [version])
    return { conflict: false, mtime: after.mtime, size: after.size }
  }

  close(dbId: string): void {
    this.open.get(dbId)?.close()
    this.open.delete(dbId)
  }

  closeAll(): void {
    for (const id of [...this.open.keys()]) this.close(id)
  }
}
