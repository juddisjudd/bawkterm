import { resolve, sep } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

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
