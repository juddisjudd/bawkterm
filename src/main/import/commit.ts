import { promises as fsp } from 'node:fs'
import { basename } from 'node:path'
import { blankHost } from '@shared/defaults'
import type { Host, ImportSummary, SshKey } from '@shared/types'
import { describeKey } from '../keys'
import { cleanHost } from '../validate'
import type { Vault } from '../vault'

export interface Endpoint {
  address: string
  port: number
  username: string
  password?: string
  keyFile?: string
}

export interface Found extends Endpoint {
  label: string
  group: string
  notes?: string
  tags?: string[]
  bookmarks?: string[]
  // another found host by its label, or a server to connect through
  jump?: { label: string } | Endpoint
}

export interface Scan {
  hosts: Found[]
  skipped: string[]
}

const MAX_KEY_FILE = 64 * 1024

const sameEndpoint = (h: Pick<Host, 'kind' | 'address' | 'port' | 'username'>, e: Endpoint): boolean =>
  h.kind === 'ssh' && h.address.toLowerCase() === e.address.toLowerCase() && h.port === e.port && h.username === e.username

// adds what a scan found to the vault, skipping hosts it already has and reusing keys it already holds
export async function commit(vault: Vault, scan: Scan): Promise<ImportSummary> {
  const summary: ImportSummary = { hosts: 0, keys: 0, skipped: [...scan.skipped] }
  const existing = vault.get()
  const keys: SshKey[] = []
  const hosts: Host[] = []
  const keyIds = new Map<string, string>()

  const loadKey = async (file: string, owner: string): Promise<string> => {
    const known = keyIds.get(file)
    if (known !== undefined) return known
    let keyId = ''
    try {
      if ((await fsp.stat(file)).size > MAX_KEY_FILE) throw new Error('the file is too large to be a private key')
      const fields = describeKey({ label: '', privateKey: await fsp.readFile(file, 'utf8'), passphrase: '' }, true)
      const same = [...existing.keys, ...keys].find(
        (k) => (fields.fingerprint && k.fingerprint === fields.fingerprint) || k.privateKey === fields.privateKey
      )
      if (same) keyId = same.id
      else {
        const now = Date.now()
        const label = fields.type === 'encrypted' ? basename(file) : fields.label
        keys.push({ ...fields, label, id: vault.newId(), createdAt: now, updatedAt: now })
        keyId = keys[keys.length - 1].id
      }
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'file not found' : (err as Error).message
      summary.skipped.push(`${owner}: key ${file} not imported (${reason})`)
    }
    keyIds.set(file, keyId)
    return keyId
  }

  const makeHost = async (label: string, group: string, e: Endpoint, extra: Partial<Host> = {}): Promise<Host> => {
    const keyId = e.keyFile ? await loadKey(e.keyFile, label) : ''
    return cleanHost({
      ...blankHost(),
      ...extra,
      id: vault.newId(),
      label: label.slice(0, 256),
      address: e.address.trim(),
      port: e.port,
      username: e.username.slice(0, 256),
      password: e.password ?? '',
      group: group.slice(0, 128),
      keyId,
      useAgent: !keyId && !e.password
    })
  }

  const findEndpoint = (e: Endpoint): Host | undefined => [...existing.hosts, ...hosts].find((h) => sameEndpoint(h, e))

  const made = new Map<Found, Host>()
  // a skipped duplicate still answers for its label, so jumps that name it reach the host already there
  const byLabel = new Map<string, Host>()
  for (const f of scan.hosts) {
    const stored = existing.hosts.find((h) => sameEndpoint(h, f))
    const match = stored ?? hosts.find((h) => sameEndpoint(h, f))
    if (match) {
      byLabel.set(f.label, match)
      summary.skipped.push(`${f.label}: ${stored ? 'already in the vault' : 'same server as another entry in this import'}`)
      continue
    }
    try {
      const host = await makeHost(f.label, f.group, f, { notes: f.notes ?? '', tags: f.tags ?? [], bookmarks: f.bookmarks ?? [] })
      hosts.push(host)
      made.set(f, host)
      byLabel.set(f.label, host)
    } catch (err) {
      summary.skipped.push(`${f.label}: ${(err as Error).message}`)
    }
  }

  for (const [f, host] of made) {
    const jump = f.jump
    if (!jump) continue
    let through: Host | undefined
    if ('label' in jump) {
      through = byLabel.get(jump.label) ?? existing.hosts.find((h) => h.label === jump.label)
    } else {
      through = findEndpoint(jump)
      if (!through) {
        try {
          through = await makeHost(jump.address, f.group, jump)
          hosts.push(through)
        } catch (err) {
          summary.skipped.push(`${f.label}: jump host ${jump.address} not imported (${(err as Error).message})`)
        }
      }
    }
    if (through && through.id !== host.id) host.jumpHostId = through.id
    else if (!through && 'label' in jump) summary.skipped.push(`${f.label}: jump host "${jump.label}" not found`)
  }

  if (hosts.length || keys.length) {
    await vault.mutate((d) => {
      d.keys.push(...keys)
      d.hosts.push(...hosts)
    })
  }
  summary.hosts = hosts.length
  summary.keys = keys.length
  return summary
}
