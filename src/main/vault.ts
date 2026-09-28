import { app, safeStorage } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { DEFAULT_SETTINGS, emptySync, emptyVault } from '@shared/defaults'
import type { VaultData, VaultStatus } from '@shared/types'

interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

interface VaultFile {
  format: 'bawkterm-vault'
  version: 1
  kdf: KdfParams
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

const KDF_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 }
const MIN_PASSWORD = 8

function deriveKey(password: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      Buffer.from(kdf.salt, 'base64'),
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

function seal(key: Buffer, kdf: KdfParams, plaintext: string): VaultFile {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('bawkterm-vault/1'))
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    format: 'bawkterm-vault',
    version: 1,
    kdf,
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

function open(key: Buffer, file: VaultFile): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'))
  decipher.setAAD(Buffer.from('bawkterm-vault/1'))
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8')
}

function normalize(raw: Partial<VaultData>): VaultData {
  const base = emptyVault()
  return {
    version: 1,
    hosts: (raw.hosts ?? []).map((h) => ({ ...h, tags: h.tags ?? [] })),
    keys: (raw.keys ?? base.keys).map((k) => ({ ...k, updatedAt: k.updatedAt ?? k.createdAt })),
    identities: (raw.identities ?? base.identities).map((i) => ({ ...i, updatedAt: i.updatedAt ?? i.createdAt })),
    knownHosts: raw.knownHosts ?? base.knownHosts,
    snippets: raw.snippets ?? base.snippets,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    sync: { ...emptySync(), ...(raw.sync ?? {}) }
  }
}

export class Vault {
  private data: VaultData | null = null
  private key: Buffer | null = null
  private kdf: KdfParams | null = null
  private writing: Promise<void> = Promise.resolve()
  private listeners = new Set<(data: VaultData | null) => void>()

  private readonly file = join(app.getPath('userData'), 'vault.json')
  private readonly rememberFile = join(app.getPath('userData'), 'vault.key')

  onChange(fn: (data: VaultData | null) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.data)
  }

  get unlocked(): boolean {
    return this.data !== null
  }

  status(): VaultStatus {
    return {
      state: this.data ? 'unlocked' : existsSync(this.file) ? 'locked' : 'none',
      remembered: existsSync(this.rememberFile),
      canRemember: safeStorage.isEncryptionAvailable()
    }
  }

  get(): VaultData {
    if (!this.data) throw new Error('Vault is locked')
    return this.data
  }

  async tryAutoUnlock(): Promise<boolean> {
    if (this.data || !existsSync(this.rememberFile) || !existsSync(this.file)) return false
    if (!safeStorage.isEncryptionAvailable()) return false
    try {
      const sealedKey = await fs.readFile(this.rememberFile)
      const key = Buffer.from(safeStorage.decryptString(sealedKey), 'base64')
      const file = await this.readFile()
      this.data = normalize(JSON.parse(open(key, file)))
      this.key = key
      this.kdf = file.kdf
      return true
    } catch {
      await fs.rm(this.rememberFile, { force: true })
      return false
    }
  }

  async create(password: string, remember: boolean): Promise<VaultData> {
    if (existsSync(this.file)) throw new Error('A vault already exists')
    if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters`)
    this.kdf = { name: 'scrypt', ...KDF_DEFAULTS, salt: randomBytes(16).toString('base64') }
    this.key = await deriveKey(password, this.kdf)
    this.data = emptyVault()
    await this.persist()
    await this.setRemember(remember)
    this.emit()
    return this.data
  }

  async unlock(password: string, remember: boolean): Promise<VaultData> {
    const file = await this.readFile()
    const key = await deriveKey(password, file.kdf)
    let plaintext: string
    try {
      plaintext = open(key, file)
    } catch {
      throw new Error('Wrong master password')
    }
    this.data = normalize(JSON.parse(plaintext))
    this.key = key
    this.kdf = file.kdf
    await this.setRemember(remember)
    this.emit()
    return this.data
  }

  lock(): void {
    this.key?.fill(0)
    this.key = null
    this.data = null
    this.emit()
  }

  async setRemember(on: boolean): Promise<void> {
    if (!on) {
      await fs.rm(this.rememberFile, { force: true })
      return
    }
    if (!this.key) throw new Error('Vault is locked')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available')
    await fs.writeFile(this.rememberFile, safeStorage.encryptString(this.key.toString('base64')))
  }

  async changePassword(current: string, next: string): Promise<void> {
    if (!this.data || !this.kdf) throw new Error('Vault is locked')
    if (next.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters`)
    const check = await deriveKey(current, this.kdf)
    if (!this.key || !check.equals(this.key)) throw new Error('Current password is wrong')
    const remembered = existsSync(this.rememberFile)
    this.kdf = { name: 'scrypt', ...KDF_DEFAULTS, salt: randomBytes(16).toString('base64') }
    this.key = await deriveKey(next, this.kdf)
    await this.persist()
    if (remembered) await this.setRemember(true)
  }

  async mutate<T>(fn: (data: VaultData) => T): Promise<T> {
    const result = fn(this.get())
    await this.persist()
    this.emit()
    return result
  }

  newId(): string {
    return randomUUID()
  }

  private async readFile(): Promise<VaultFile> {
    const file = JSON.parse(await fs.readFile(this.file, 'utf8')) as VaultFile
    if (file.format !== 'bawkterm-vault' || file.version !== 1) throw new Error('Unknown vault format')
    return file
  }

  private persist(): Promise<void> {
    const key = this.key
    const kdf = this.kdf
    const data = this.data
    if (!key || !kdf || !data) return Promise.reject(new Error('Vault is locked'))
    const sealed = JSON.stringify(seal(key, kdf, JSON.stringify(data)))
    this.writing = this.writing.catch(() => {}).then(async () => {
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, sealed, { mode: 0o600 })
      if (existsSync(this.file)) await fs.copyFile(this.file, `${this.file}.bak`)
      await fs.rename(tmp, this.file)
    })
    return this.writing
  }
}
