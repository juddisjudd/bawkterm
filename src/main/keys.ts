import { createHash } from 'node:crypto'
import { utils, type ParsedKey } from 'ssh2'
import type { KeyGenRequest, KeyImportRequest, SshKey } from '@shared/types'

export function fingerprintOf(publicBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')
}

export function isEncryptedKeyError(err: Error): boolean {
  return /encrypted|passphrase|decrypt/i.test(err.message)
}

export function parsePrivateKey(pem: string, passphrase?: string): ParsedKey | Error {
  const parsed = utils.parseKey(pem, passphrase || undefined)
  if (parsed instanceof Error) return parsed
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key) return new Error('No key found')
  if (!key.isPrivateKey()) return new Error('This is a public key. Import the private key file instead.')
  return key
}

export function parsePublicBlob(blob: Buffer): string {
  const parsed = utils.parseKey(blob)
  if (parsed instanceof Error) return 'unknown'
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.type ?? 'unknown'
}

type KeyFields = Omit<SshKey, 'id' | 'createdAt' | 'updatedAt'>

export function describeKey(req: KeyImportRequest, allowLocked = false): KeyFields {
  const privateKey = req.privateKey.replace(/\r\n/g, '\n').trim() + '\n'
  const bare = parsePrivateKey(privateKey)
  const encrypted = bare instanceof Error && isEncryptedKeyError(bare)
  if (bare instanceof Error && !encrypted) throw new Error(`Unreadable key: ${bare.message}`)

  const parsed = encrypted ? parsePrivateKey(privateKey, req.passphrase) : bare
  if (parsed instanceof Error) {
    if (!allowLocked) {
      throw new Error(req.passphrase ? 'Wrong passphrase for this key' : 'This key is encrypted. Enter its passphrase.')
    }
    return {
      label: req.label || 'Encrypted key',
      type: 'encrypted',
      privateKey,
      passphrase: '',
      publicKey: '',
      fingerprint: '',
      encrypted: true
    }
  }

  const blob = parsed.getPublicSSH()
  const comment = parsed.comment?.trim()
  return {
    label: req.label || comment || parsed.type,
    type: parsed.type,
    privateKey,
    passphrase: encrypted ? req.passphrase : '',
    publicKey: `${parsed.type} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    fingerprint: fingerprintOf(blob),
    encrypted
  }
}

export function generateKey(req: KeyGenRequest): KeyImportRequest {
  const opts = {
    comment: req.comment || undefined,
    passphrase: req.passphrase || undefined,
    cipher: req.passphrase ? 'aes256-ctr' : undefined
  }
  const pair = (() => {
    switch (req.type) {
      case 'ed25519':
        return utils.generateKeyPairSync('ed25519', opts)
      case 'rsa-4096':
        return utils.generateKeyPairSync('rsa', { ...opts, bits: 4096 })
      case 'ecdsa-256':
        return utils.generateKeyPairSync('ecdsa', { ...opts, bits: 256 })
      case 'ecdsa-521':
        return utils.generateKeyPairSync('ecdsa', { ...opts, bits: 521 })
    }
  })()
  return { label: req.label, privateKey: pair.private, passphrase: req.passphrase }
}
