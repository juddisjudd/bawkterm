import { app } from 'electron'
import { hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PasskeyEnrollment, UnlockStatus, VaultData } from '@shared/types'
import { writeFileAtomic } from './files'
import { helloDelete, helloSign, helloSupported } from './hello'
import { unwrapKey, type Vault, type Wrapped } from './vault'

// version 1 files predate per-vault key names and used this shared one
const LEGACY_HELLO_KEY = 'bawkterm-vault'

interface HelloFile {
  version: 1 | 2
  keyName?: string
  challenge: string
  wrapped: Wrapped
}

interface PasskeyFile extends PasskeyEnrollment {
  version: 1
  wrapped: Wrapped
}

function kek(secret: Buffer, salt: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, salt, `bawkterm/${purpose}`, 32))
}

function unwrapWith(secret: Buffer, salt: Buffer, purpose: string, wrapped: Wrapped): Buffer {
  const k = kek(secret, salt, purpose)
  try {
    return unwrapKey(k, wrapped, purpose)
  } finally {
    k.fill(0)
    secret.fill(0)
  }
}

// Extra ways to open the vault. Each keeps its own wrapped copy of the vault key outside the vault file.
export class UnlockMethods {
  private readonly helloFile = join(app.getPath('userData'), 'unlock-hello.json')
  private readonly passkeyFile = join(app.getPath('userData'), 'unlock-passkey.json')
  private supported: Promise<boolean> | undefined

  constructor(private vault: Vault) {}

  async status(): Promise<UnlockStatus> {
    this.supported ??= helloSupported()
    const passkey = await this.readPasskey()
    return {
      hello: { supported: await this.supported, enabled: existsSync(this.helloFile) },
      passkey: passkey
        ? { enabled: true, credentialId: passkey.credentialId, salt: passkey.salt, rpId: passkey.rpId, transports: passkey.transports }
        : { enabled: false }
    }
  }

  async enableHello(): Promise<void> {
    if (!this.vault.unlocked) throw new Error('Vault is locked')
    this.supported = undefined
    const previous = await this.readHello()
    const keyName = `bawkterm-${randomBytes(8).toString('hex')}`
    const challenge = randomBytes(32)
    const signature = await helloSign(keyName, challenge, true)
    const k = kek(signature, challenge, 'hello')
    const file: HelloFile = {
      version: 2,
      keyName,
      challenge: challenge.toString('base64'),
      wrapped: this.vault.wrapCurrentKey(k, 'hello')
    }
    k.fill(0)
    signature.fill(0)
    await writeFileAtomic(this.helloFile, JSON.stringify(file))
    if (previous) await helloDelete(previous.keyName ?? LEGACY_HELLO_KEY)
  }

  async unlockWithHello(): Promise<VaultData> {
    const file = await this.readHello()
    if (!file) throw new Error('Windows Hello unlock is not set up')
    const challenge = Buffer.from(file.challenge, 'base64')
    const signature = await helloSign(file.keyName ?? LEGACY_HELLO_KEY, challenge, false)
    let key: Buffer
    try {
      key = unwrapWith(signature, challenge, 'hello', file.wrapped)
    } catch {
      throw new Error('Windows Hello answered, but its key no longer matches. Turn Windows Hello unlock off and on again.')
    }
    return this.vault.unlockWithKey(key)
  }

  // deleting the Windows key is what really revokes it; an old copy of the file is useless without it
  async disableHello(): Promise<void> {
    const file = await this.readHello()
    await fs.rm(this.helloFile, { force: true })
    if (file) await helloDelete(file.keyName ?? LEGACY_HELLO_KEY)
  }

  async enablePasskey(enrollment: PasskeyEnrollment, prfOutput: string): Promise<void> {
    if (!this.vault.unlocked) throw new Error('Vault is locked')
    const secret = Buffer.from(prfOutput, 'base64')
    if (secret.length < 32) throw new Error('The passkey returned too little key material')
    const k = kek(secret, Buffer.from(enrollment.salt, 'base64'), 'passkey')
    const file: PasskeyFile = {
      version: 1,
      credentialId: enrollment.credentialId,
      salt: enrollment.salt,
      rpId: enrollment.rpId,
      transports: enrollment.transports,
      wrapped: this.vault.wrapCurrentKey(k, 'passkey')
    }
    k.fill(0)
    secret.fill(0)
    await writeFileAtomic(this.passkeyFile, JSON.stringify(file))
  }

  async unlockWithPasskey(prfOutput: string): Promise<VaultData> {
    const file = await this.readPasskey()
    if (!file) throw new Error('Passkey unlock is not set up')
    let key: Buffer
    try {
      key = unwrapWith(Buffer.from(prfOutput, 'base64'), Buffer.from(file.salt, 'base64'), 'passkey', file.wrapped)
    } catch {
      throw new Error('That passkey does not unlock this vault')
    }
    return this.vault.unlockWithKey(key)
  }

  async disablePasskey(): Promise<void> {
    await fs.rm(this.passkeyFile, { force: true })
  }

  // after the vault key changes, every wrapped copy is stale and must be enrolled again
  async revokeAll(): Promise<void> {
    await this.disableHello()
    await this.disablePasskey()
  }

  private async readHello(): Promise<HelloFile | null> {
    if (!existsSync(this.helloFile)) return null
    return JSON.parse(await fs.readFile(this.helloFile, 'utf8')) as HelloFile
  }

  private async readPasskey(): Promise<PasskeyFile | null> {
    if (!existsSync(this.passkeyFile)) return null
    return JSON.parse(await fs.readFile(this.passkeyFile, 'utf8')) as PasskeyFile
  }
}
