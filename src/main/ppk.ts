import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { argon2d, argon2i, argon2id } from '@noble/hashes/argon2.js'

// Reads PuTTY .ppk keys (format 2 and 3) and rewrites them as unencrypted OpenSSH keys, which ssh2 can parse.

const MAX_LINES = 512
const MAX_ARGON2_MEMORY = 256 * 1024
// Electron's BoringSSL has no Argon2, so it runs in JavaScript: PuTTY's default costs about 0.4 s, this cap 16 times that
const MAX_ARGON2_WORK = 16 * 8192 * 21
const ARGON2 = { Argon2d: argon2d, Argon2i: argon2i, Argon2id: argon2id } as const

interface PpkFile {
  version: 2 | 3
  type: string
  encryption: string
  comment: string
  publicBlob: Buffer
  privateBlob: Buffer
  mac: Buffer
  argon2?: { derive: (typeof ARGON2)[keyof typeof ARGON2]; memory: number; passes: number; parallelism: number; salt: Buffer }
}

export const isPpk = (text: string): boolean => /^\s*PuTTY-User-Key-File-\d+:/.test(text)

const damaged = (what: string): Error => new Error(`Damaged PuTTY key: ${what}`)

function parseFile(text: string): PpkFile {
  const lines = text.trim().split(/\r?\n/)
  let at = 0
  const header = (name: string): string => {
    const m = lines[at]?.match(/^([\w-]+): ?(.*)$/)
    if (!m || m[1] !== name) throw damaged(`missing ${name}`)
    at++
    return m[2].trim()
  }
  const block = (name: string): Buffer => {
    const count = Number(header(name))
    if (!Number.isInteger(count) || count < 0 || count > MAX_LINES || at + count > lines.length) throw damaged(name)
    const data = lines.slice(at, at + count).join('')
    at += count
    return Buffer.from(data, 'base64')
  }
  const first = lines[at++]?.match(/^PuTTY-User-Key-File-(\d+): (\S+)$/)
  if (!first) throw damaged('unknown header')
  const version = Number(first[1])
  if (version !== 2 && version !== 3) throw new Error(`PuTTY key format ${version} is not supported. Save it again with PuTTYgen 0.75 or newer.`)
  const encryption = header('Encryption')
  if (encryption !== 'none' && encryption !== 'aes256-cbc') throw new Error(`PuTTY key encryption "${encryption}" is not supported`)
  const comment = header('Comment')
  const publicBlob = block('Public-Lines')
  let argon2: PpkFile['argon2']
  if (version === 3 && encryption !== 'none') {
    const variant = header('Key-Derivation') as keyof typeof ARGON2
    if (!(variant in ARGON2)) throw new Error(`PuTTY key derivation "${variant}" is not supported`)
    const memory = Number(header('Argon2-Memory'))
    const passes = Number(header('Argon2-Passes'))
    const parallelism = Number(header('Argon2-Parallelism'))
    const salt = Buffer.from(header('Argon2-Salt'), 'hex')
    const sane = (n: number, max: number): boolean => Number.isInteger(n) && n >= 1 && n <= max
    if (!sane(memory, MAX_ARGON2_MEMORY) || !sane(passes, MAX_ARGON2_WORK) || !sane(parallelism, 64) || memory * passes > MAX_ARGON2_WORK) {
      throw new Error('This PuTTY key asks for more key-derivation work than bawkterm allows')
    }
    if (salt.length < 8) throw damaged('salt')
    argon2 = { derive: ARGON2[variant], memory, passes, parallelism, salt }
  }
  const privateBlob = block('Private-Lines')
  const mac = Buffer.from(header('Private-MAC'), 'hex')
  return { version, type: first[2], encryption, comment, publicBlob, privateBlob, mac, argon2 }
}

class Reader {
  private pos = 0
  constructor(private readonly buf: Buffer) {}

  string(): Buffer {
    if (this.pos + 4 > this.buf.length) throw damaged('truncated key data')
    const len = this.buf.readUInt32BE(this.pos)
    const start = this.pos + 4
    if (start + len > this.buf.length) throw damaged('truncated key data')
    this.pos = start + len
    return this.buf.subarray(start, start + len)
  }
}

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data) : data
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  return Buffer.concat([len, body])
}

function sha1(...parts: (Buffer | string)[]): Buffer {
  const h = createHash('sha1')
  for (const p of parts) h.update(p)
  return h.digest()
}

function secrets(file: PpkFile, passphrase: string): { cipherKey?: Buffer; iv?: Buffer; macKey: Buffer } {
  const pass = Buffer.from(passphrase, 'utf8')
  if (file.version === 2) {
    const macKey = sha1('putty-private-key-file-mac-key', file.encryption === 'none' ? '' : pass)
    if (file.encryption === 'none') return { macKey }
    const cipherKey = Buffer.concat([sha1(Buffer.from([0, 0, 0, 0]), pass), sha1(Buffer.from([0, 0, 0, 1]), pass)]).subarray(0, 32)
    return { cipherKey, iv: Buffer.alloc(16), macKey }
  }
  if (!file.argon2) return { macKey: Buffer.alloc(0) }
  const { derive, memory, passes, parallelism, salt } = file.argon2
  const out = Buffer.from(derive(pass, salt, { t: passes, m: memory, p: parallelism, dkLen: 80 }))
  return { cipherKey: out.subarray(0, 32), iv: out.subarray(32, 48), macKey: out.subarray(48, 80) }
}

// OpenSSH orders each key type's fields differently from PuTTY's public and private halves
function opensshFields(type: string, pub: Reader, priv: Reader): Buffer[] {
  if (type === 'ssh-ed25519') {
    const publicKey = pub.string()
    const seed = priv.string()
    if (publicKey.length !== 32 || seed.length !== 32) throw damaged('ed25519 key size')
    return [sshString(publicKey), sshString(Buffer.concat([seed, publicKey]))]
  }
  if (type === 'ssh-rsa') {
    const e = pub.string()
    const n = pub.string()
    const [d, p, q, iqmp] = [priv.string(), priv.string(), priv.string(), priv.string()]
    return [n, e, d, iqmp, p, q].map(sshString)
  }
  if (type === 'ssh-dss') {
    const [p, q, g, y] = [pub.string(), pub.string(), pub.string(), pub.string()]
    return [p, q, g, y, priv.string()].map(sshString)
  }
  if (/^ecdsa-sha2-nistp(256|384|521)$/.test(type)) {
    const curve = pub.string()
    const point = pub.string()
    return [curve, point, priv.string()].map(sshString)
  }
  throw new Error(`PuTTY keys of type ${type} are not supported`)
}

function toOpenSsh(file: PpkFile, privateBlob: Buffer): string {
  const pub = new Reader(file.publicBlob)
  if (pub.string().toString() !== file.type) throw damaged('key type mismatch')
  const check = randomBytes(4)
  const body = Buffer.concat([
    check,
    check,
    sshString(file.type),
    ...opensshFields(file.type, pub, new Reader(privateBlob)),
    sshString(file.comment)
  ])
  const padding = Buffer.from(Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, i) => i + 1))
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(file.publicBlob),
    sshString(Buffer.concat([body, padding]))
  ])
  const lines = blob.toString('base64').match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

export function ppkPublic(text: string): { type: string; blob: Buffer; comment: string; encrypted: boolean } {
  const file = parseFile(text)
  return { type: file.type, blob: file.publicBlob, comment: file.comment, encrypted: file.encryption !== 'none' }
}

// errors mention "encrypted" or "passphrase" so callers treat them like ssh2's own locked-key errors
export function ppkToOpenSsh(text: string, passphrase = ''): string | Error {
  let file: PpkFile
  try {
    file = parseFile(text)
  } catch (err) {
    return err as Error
  }
  const encrypted = file.encryption !== 'none'
  if (encrypted && !passphrase) return new Error('This PuTTY key is encrypted. Enter its passphrase.')
  const { cipherKey, iv, macKey } = secrets(file, passphrase)
  let privateBlob = file.privateBlob
  if (cipherKey && iv) {
    if (privateBlob.length % 16) return damaged('private data length')
    const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv).setAutoPadding(false)
    privateBlob = Buffer.concat([decipher.update(privateBlob), decipher.final()])
  }
  const signed = Buffer.concat([
    sshString(file.type),
    sshString(file.encryption),
    sshString(file.comment),
    sshString(file.publicBlob),
    sshString(privateBlob)
  ])
  const expected = createHmac(file.version === 2 ? 'sha1' : 'sha256', macKey).update(signed).digest()
  if (expected.length !== file.mac.length || !timingSafeEqual(expected, file.mac)) {
    return encrypted ? new Error('Wrong passphrase for this PuTTY key') : damaged('checksum does not match')
  }
  try {
    return toOpenSsh(file, privateBlob)
  } catch (err) {
    return err as Error
  } finally {
    privateBlob.fill(0)
  }
}
