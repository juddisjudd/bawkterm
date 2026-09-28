import { app, safeStorage } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { DEFAULT_SETTINGS, emptyLocal, emptySync, emptyVault } from '@shared/defaults'
import type { VaultData, VaultStatus } from '@shared/types'

interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string
}

export interface Wrapped {
  iv: string
  tag: string
  data: string
}

interface Sealed {
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

// v1: data encrypted directly with the password-derived key
interface VaultFileV1 extends Sealed {
  format: 'bawkterm-vault'
  version: 1
  kdf: KdfParams
}

// v2: data encrypted with a random vault key; each unlock method stores its own wrapped copy
interface VaultFileV2 extends Sealed {
  format: 'bawkterm-vault'
  version: 2
  password: { kdf: KdfParams; key: Wrapped }
}

type VaultFile = VaultFileV1 | VaultFileV2

const KDF_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 }
const MIN_PASSWORD = 8
const DATA_AAD = Buffer.from('bawkterm-vault/1')

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

function newKdf(): KdfParams {
  return { name: 'scrypt', ...KDF_DEFAULTS, salt: randomBytes(16).toString('base64') }
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Wrapped {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function decrypt(key: Buffer, box: Wrapped, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()])
}

export function wrapKey(kek: Buffer, key: Buffer, purpose: string): Wrapped {
  return encrypt(kek, key, Buffer.from(`bawkterm-key/${purpose}`))
}

export function unwrapKey(kek: Buffer, wrapped: Wrapped, purpose: string): Buffer {
  return decrypt(kek, wrapped, Buffer.from(`bawkterm-key/${purpose}`))
}

function normalize(raw: Partial<VaultData>): VaultData {
  const base = emptyVault()
  return {
    version: 1,
    hosts: (raw.hosts ?? []).map((h) => ({
      ...h,
      kind: h.kind ?? 'ssh',
      rdpFullscreen: h.rdpFullscreen ?? true,
      startupCommand: h.startupCommand ?? '',
      bookmarks: h.bookmarks ?? [],
      folderColors: h.folderColors ?? {},
      tags: h.tags ?? []
    })),
    keys: (raw.keys ?? base.keys).map((k) => ({ ...k, updatedAt: k.updatedAt ?? k.createdAt })),
    identities: (raw.identities ?? base.identities).map((i) => ({ ...i, updatedAt: i.updatedAt ?? i.createdAt })),
    knownHosts: raw.knownHosts ?? base.knownHosts,
    snippets: raw.snippets ?? base.snippets,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    sync: { ...emptySync(), ...(raw.sync ?? {}) },
    local: { ...emptyLocal(), ...(raw.local ?? {}) }
  }
}

export class Vault {
  private data: VaultData | null = null
  private key: Buffer | null = null
  private passwordLock: VaultFileV2['password'] | null = null
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

  get exists(): boolean {
    return existsSync(this.file)
  }

  status(): VaultStatus {
    return {
      state: this.data ? 'unlocked' : this.exists ? 'locked' : 'none',
      remembered: existsSync(this.rememberFile),
      canRemember: safeStorage.isEncryptionAvailable()
    }
  }

  get(): VaultData {
    if (!this.data) throw new Error('Vault is locked')
    return this.data
  }

  wrapCurrentKey(kek: Buffer, purpose: string): Wrapped {
    if (!this.key) throw new Error('Vault is locked')
    return wrapKey(kek, this.key, purpose)
  }

  async tryAutoUnlock(): Promise<boolean> {
    if (this.data || !existsSync(this.rememberFile) || !this.exists) return false
    if (!safeStorage.isEncryptionAvailable()) return false
    try {
      const key = Buffer.from(safeStorage.decryptString(await fs.readFile(this.rememberFile)), 'base64')
      const file = await this.readFile()
      if (file.version === 1) await this.openLegacy(file, key)
      else this.openWithKey(file, key)
      return true
    } catch {
      await fs.rm(this.rememberFile, { force: true })
      return false
    }
  }

  async create(password: string, remember: boolean): Promise<VaultData> {
    if (this.exists) throw new Error('A vault already exists')
    if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters`)
    const kdf = newKdf()
    this.key = randomBytes(32)
    this.passwordLock = { kdf, key: wrapKey(await deriveKey(password, kdf), this.key, 'password') }
    this.data = emptyVault()
    await this.persist()
    await this.setRemember(remember)
    this.emit()
    return this.data
  }

  async unlock(password: string, remember: boolean): Promise<VaultData> {
    const file = await this.readFile()
    if (file.version === 1) {
      await this.openLegacy(file, await deriveKey(password, file.kdf))
    } else {
      let key: Buffer
      try {
        key = unwrapKey(await deriveKey(password, file.password.kdf), file.password.key, 'password')
      } catch {
        throw new Error('Wrong master password')
      }
      this.openWithKey(file, key)
    }
    await this.setRemember(remember)
    this.emit()
    return this.data!
  }

  // for unlock methods that hold their own wrapped copy of the vault key
  async unlockWithKey(key: Buffer): Promise<VaultData> {
    const file = await this.readFile()
    if (file.version === 1) throw new Error('Unlock with your master password once to finish upgrading the vault')
    this.openWithKey(file, key)
    this.emit()
    return this.data!
  }

  private openWithKey(file: VaultFileV2, key: Buffer): void {
    let plaintext: Buffer
    try {
      plaintext = decrypt(key, file, DATA_AAD)
    } catch {
      throw new Error('This unlock method no longer matches the vault')
    }
    this.data = normalize(JSON.parse(plaintext.toString('utf8')))
    this.key = key
    this.passwordLock = file.password
  }

  // upgrades a v1 vault: new random vault key, wrapped by the password-derived key
  private async openLegacy(file: VaultFileV1, passwordKey: Buffer): Promise<void> {
    let plaintext: Buffer
    try {
      plaintext = decrypt(passwordKey, file, DATA_AAD)
    } catch {
      throw new Error('Wrong master password')
    }
    this.data = normalize(JSON.parse(plaintext.toString('utf8')))
    this.key = randomBytes(32)
    this.passwordLock = { kdf: file.kdf, key: wrapKey(passwordKey, this.key, 'password') }
    const remembered = existsSync(this.rememberFile)
    await this.persist()
    if (remembered) await this.setRemember(true)
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
    if (!this.data || !this.key || !this.passwordLock) throw new Error('Vault is locked')
    if (next.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters`)
    try {
      const check = unwrapKey(await deriveKey(current, this.passwordLock.kdf), this.passwordLock.key, 'password')
      if (!check.equals(this.key)) throw new Error()
    } catch {
      throw new Error('Current password is wrong')
    }
    const kdf = newKdf()
    this.passwordLock = { kdf, key: wrapKey(await deriveKey(next, kdf), this.key, 'password') }
    await this.persist()
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
    if (file.format !== 'bawkterm-vault' || (file.version !== 1 && file.version !== 2)) {
      throw new Error('Unknown vault format')
    }
    return file
  }

  private persist(): Promise<void> {
    const key = this.key
    const passwordLock = this.passwordLock
    const data = this.data
    if (!key || !passwordLock || !data) return Promise.reject(new Error('Vault is locked'))
    const file: VaultFileV2 = {
      format: 'bawkterm-vault',
      version: 2,
      password: passwordLock,
      cipher: 'aes-256-gcm',
      ...encrypt(key, Buffer.from(JSON.stringify(data), 'utf8'), DATA_AAD)
    }
    const sealed = JSON.stringify(file)
    this.writing = this.writing.catch(() => {}).then(async () => {
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, sealed, { mode: 0o600 })
      if (existsSync(this.file)) await fs.copyFile(this.file, `${this.file}.bak`)
      await fs.rename(tmp, this.file)
    })
    return this.writing
  }
}
