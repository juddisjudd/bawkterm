import { app } from 'electron'
import { hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PasskeyEnrollment, UnlockStatus, VaultData } from '@shared/types'
import { helloSign, helloSupported } from './hello'
import { unwrapKey, type Vault, type Wrapped } from './vault'

interface HelloFile {
  version: 1
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
    this.supported = undefined
    const challenge = randomBytes(32)
    const signature = await helloSign(challenge, true)
    const file: HelloFile = {
      version: 1,
      challenge: challenge.toString('base64'),
      wrapped: this.vault.wrapCurrentKey(kek(signature, challenge, 'hello'), 'hello')
    }
    await fs.writeFile(this.helloFile, JSON.stringify(file), { mode: 0o600 })
  }

  async unlockWithHello(): Promise<VaultData> {
    if (!existsSync(this.helloFile)) throw new Error('Windows Hello unlock is not set up')
    const file = JSON.parse(await fs.readFile(this.helloFile, 'utf8')) as HelloFile
    const challenge = Buffer.from(file.challenge, 'base64')
    const signature = await helloSign(challenge, false)
    let key: Buffer
    try {
      key = unwrapKey(kek(signature, challenge, 'hello'), file.wrapped, 'hello')
    } catch {
      throw new Error('Windows Hello answered, but its key no longer matches. Turn Windows Hello unlock off and on again.')
    }
    return this.vault.unlockWithKey(key)
  }

  async disableHello(): Promise<void> {
    await fs.rm(this.helloFile, { force: true })
  }

  async enablePasskey(enrollment: PasskeyEnrollment, prfOutput: string): Promise<void> {
    const secret = Buffer.from(prfOutput, 'base64')
    if (secret.length < 32) throw new Error('The passkey returned too little key material')
    const file: PasskeyFile = {
      version: 1,
      ...enrollment,
      wrapped: this.vault.wrapCurrentKey(kek(secret, Buffer.from(enrollment.salt, 'base64'), 'passkey'), 'passkey')
    }
    await fs.writeFile(this.passkeyFile, JSON.stringify(file), { mode: 0o600 })
  }

  async unlockWithPasskey(prfOutput: string): Promise<VaultData> {
    const file = await this.readPasskey()
    if (!file) throw new Error('Passkey unlock is not set up')
    let key: Buffer
    try {
      key = unwrapKey(kek(Buffer.from(prfOutput, 'base64'), Buffer.from(file.salt, 'base64'), 'passkey'), file.wrapped, 'passkey')
    } catch {
      throw new Error('That passkey does not unlock this vault')
    }
    return this.vault.unlockWithKey(key)
  }

  async disablePasskey(): Promise<void> {
    await fs.rm(this.passkeyFile, { force: true })
  }

  private async readPasskey(): Promise<PasskeyFile | null> {
    if (!existsSync(this.passkeyFile)) return null
    return JSON.parse(await fs.readFile(this.passkeyFile, 'utf8')) as PasskeyFile
  }
}
