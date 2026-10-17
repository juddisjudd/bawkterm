import { resolve, sep } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'

const CHUNK = 32 * 1024
const PARALLEL = 32

export function call<T>(fn: (cb: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value as T))))
}

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const BIDI = /[‎‏‪-‮⁦-⁩]/g

// remote names may contain characters Windows treats as separators or rejects, so each becomes one safe component
export function localName(remote: string): string {
  let name = remote
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(BIDI, '_')
    .replace(/[. ]+$/, '')
  if (!name) name = '_'
  if (RESERVED.test(name)) name = `_${name}`
  return name
}

export function isInside(root: string, target: string): boolean {
  const base = resolve(root)
  const full = resolve(target)
  return full === base || full.startsWith(base.endsWith(sep) ? base : base + sep)
}

// stat sizes can lie (special files report 0, a hostile server can report anything), so reads stop at max bytes
export async function readBounded(sftp: SFTPWrapper, path: string, max: number, tooLarge: string): Promise<Buffer> {
  const handle = await call<Buffer>((cb) => sftp.open(path, 'r', cb))
  try {
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(64 * 1024, max + 1 - total))
      const n = await call<number>((cb) => sftp.read(handle, buf, 0, buf.length, total, cb))
      if (!n) break
      chunks.push(buf.subarray(0, n))
      total += n
      if (total > max) throw new Error(tooLarge)
    }
    return Buffer.concat(chunks, total)
  } finally {
    await call((cb) => sftp.close(handle, cb)).catch(() => {})
  }
}

// many requests in flight at once, since one at a time crawls on a high-latency link
async function inChunks(size: number, work: (pos: number, len: number) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    try {
      while (!failed && next < size) {
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
  await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.ceil(size / CHUNK)) }, worker))
}

export async function readWhole(sftp: SFTPWrapper, path: string, max: number, tooLarge: string): Promise<Buffer> {
  const handle = await call<Buffer>((cb) => sftp.open(path, 'r', cb))
  try {
    const { size } = await call<Stats>((cb) => sftp.fstat(handle, cb))
    if (size > max) throw new Error(tooLarge)
    const data = Buffer.allocUnsafe(size)
    await inChunks(size, async (pos, len) => {
      for (let got = 0; got < len; ) {
        const n = await call<number>((cb) => sftp.read(handle, data, pos + got, len - got, pos + got, cb))
        if (!n) throw new Error(`${path} changed while downloading`)
        got += n
      }
    })
    return data
  } finally {
    await call((cb) => sftp.close(handle, cb)).catch(() => {})
  }
}

export async function readHead(sftp: SFTPWrapper, path: string, length: number): Promise<Buffer> {
  const handle = await call<Buffer>((cb) => sftp.open(path, 'r', cb))
  try {
    const data = Buffer.alloc(length)
    const n = await call<number>((cb) => sftp.read(handle, data, 0, length, 0, cb))
    return data.subarray(0, n)
  } finally {
    await call((cb) => sftp.close(handle, cb)).catch(() => {})
  }
}

export async function writeWhole(sftp: SFTPWrapper, path: string, bytes: Uint8Array, mode?: number): Promise<void> {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  const handle = await call<Buffer>((cb) => sftp.open(path, 'w', mode === undefined ? {} : { mode }, cb))
  try {
    await inChunks(data.length, (pos, len) => call((cb) => sftp.write(handle, data, pos, len, pos, cb)))
  } catch (err) {
    await call((cb) => sftp.close(handle, cb)).catch(() => {})
    throw err
  }
  await call((cb) => sftp.close(handle, cb))
}
