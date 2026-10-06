import type { Host, ImportSummary, KnownHost, Snippet, SshKey, Identity, VaultData } from '@shared/types'
import { cleanHost, cleanIdentity, cleanKey, cleanKnownHost, cleanSnippet, int, line, list } from './validate'
import { decrypt, deriveKey, encrypt, newKdf, type KdfParams, type Vault } from './vault'

interface BackupFile {
  format: 'bawkterm-backup'
  version: 1
  createdAt: number
  kdf: KdfParams
  cipher: 'aes-256-gcm'
  iv: string
  tag: string
  data: string
}

interface Contents {
  hosts: Host[]
  keys: SshKey[]
  identities: Identity[]
  snippets: Snippet[]
  knownHosts: KnownHost[]
}

const AAD = Buffer.from('bawkterm-backup/1')

export class WrongPassword extends Error {
  constructor() {
    super('Wrong password for this backup')
  }
}

export const looksLikeBackup = (text: string): boolean => /^\s*\{[\s\S]*"format"\s*:\s*"bawkterm-backup"/.test(text)

export async function writeBackup(data: VaultData, password: string): Promise<string> {
  const contents: Contents = {
    hosts: data.hosts,
    keys: data.keys,
    identities: data.identities,
    snippets: data.snippets,
    knownHosts: data.knownHosts
  }
  const kdf = newKdf()
  const key = await deriveKey(password, kdf)
  const plain = Buffer.from(JSON.stringify(contents), 'utf8')
  try {
    const box = encrypt(key, plain, AAD)
    const file: BackupFile = { format: 'bawkterm-backup', version: 1, createdAt: Date.now(), kdf, cipher: 'aes-256-gcm', ...box }
    return JSON.stringify(file, null, 2)
  } finally {
    plain.fill(0)
    key.fill(0)
  }
}

// the scrypt cost comes from the file, so it is capped before any work is done
function readKdf(v: unknown): KdfParams {
  const k = (v ?? {}) as Record<string, unknown>
  const N = int(k.N, 'backup cost', 2 ** 14, 2 ** 18)
  if (N & (N - 1)) throw new Error('This backup file is damaged')
  return { name: 'scrypt', N, r: int(k.r, 'backup cost', 1, 16), p: int(k.p, 'backup cost', 1, 4), salt: line(k.salt, 'backup salt', 64) }
}

export async function readBackup(text: string, password: string): Promise<Contents> {
  let file: BackupFile
  try {
    file = JSON.parse(text) as BackupFile
  } catch {
    throw new Error('This backup file is damaged')
  }
  if (file.format !== 'bawkterm-backup' || file.version !== 1) throw new Error('This backup was made by a newer bawkterm')
  const key = await deriveKey(password, readKdf(file.kdf))
  let plain: Buffer
  try {
    plain = decrypt(key, { iv: line(file.iv, 'backup', 64), tag: line(file.tag, 'backup', 64), data: String(file.data) }, AAD)
  } catch {
    throw new WrongPassword()
  } finally {
    key.fill(0)
  }
  try {
    const raw = JSON.parse(plain.toString('utf8')) as Record<string, unknown>
    return {
      hosts: list(raw.hosts ?? [], 'hosts', 50_000, cleanHost),
      keys: list(raw.keys ?? [], 'keys', 10_000, cleanKey),
      identities: list(raw.identities ?? [], 'identities', 10_000, cleanIdentity),
      snippets: list(raw.snippets ?? [], 'snippets', 50_000, cleanSnippet),
      knownHosts: list(raw.knownHosts ?? [], 'known hosts', 50_000, cleanKnownHost)
    }
  } finally {
    plain.fill(0)
  }
}

const sameServer = (a: Host, b: Host): boolean =>
  a.kind === b.kind && a.address.toLowerCase() === b.address.toLowerCase() && a.port === b.port && a.username === b.username

// adds what the vault lacks and updates items the backup holds a newer copy of; it never deletes
export async function restoreBackup(vault: Vault, backup: Contents): Promise<ImportSummary> {
  const summary: ImportSummary = { hosts: 0, keys: 0, skipped: [] }
  let identities = 0
  let snippets = 0
  await vault.mutate((d) => {
    const ids = new Map<string, string>()
    const remap = (id: string): string => (id ? (ids.get(id) ?? id) : '')

    const merge = <T extends { id: string; updatedAt: number }>(
      mine: T[],
      item: T,
      duplicate: (existing: T) => boolean,
      describe: string
    ): 'added' | 'updated' | 'kept' => {
      const same = mine.findIndex((m) => m.id === item.id)
      if (same >= 0) {
        if (item.updatedAt <= mine[same].updatedAt) return 'kept'
        mine[same] = item
        return 'updated'
      }
      const twin = mine.find(duplicate)
      if (twin) {
        ids.set(item.id, twin.id)
        summary.skipped.push(`${describe}: already in the vault`)
        return 'kept'
      }
      mine.push(item)
      return 'added'
    }

    for (const k of backup.keys) {
      const dup = (m: SshKey): boolean => (!!k.fingerprint && m.fingerprint === k.fingerprint) || m.privateKey === k.privateKey
      if (merge(d.keys, k, dup, `key ${k.label}`) === 'added') summary.keys++
    }
    const known = (items: { id: string }[], id: string): string => (items.some((x) => x.id === id) ? id : '')
    for (const i of backup.identities) {
      const identity = { ...i, keyId: known(d.keys, remap(i.keyId)) }
      if (merge(d.identities, identity, () => false, `identity ${i.label}`) === 'added') identities++
    }
    const placed: Host[] = []
    for (const h of backup.hosts) {
      const host = { ...h, keyId: known(d.keys, remap(h.keyId)), identityId: known(d.identities, remap(h.identityId)) }
      const result = merge(d.hosts, host, (m) => sameServer(m, host), h.label || h.address)
      if (result === 'added') summary.hosts++
      if (result !== 'kept') placed.push(host)
    }
    for (const host of placed) host.jumpHostId = known(d.hosts, remap(host.jumpHostId))
    for (const s of backup.snippets) {
      if (merge(d.snippets, s, () => false, `snippet ${s.label}`) === 'added') snippets++
    }
    for (const k of backup.knownHosts) {
      const current = d.knownHosts.find((m) => m.host === k.host && m.keyType === k.keyType)
      if (!current) d.knownHosts.push(k)
      else if (current.fingerprint !== k.fingerprint) summary.skipped.push(`${k.host}: kept the host key you trust now`)
    }
  })
  return { ...summary, identities, snippets }
}
