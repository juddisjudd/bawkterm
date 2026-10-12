import { blankHost } from '@shared/defaults'
import type { Host, ImportSummary, SshKey } from '@shared/types'
import { readKeyFile, sameKey } from '../keys'
import { cleanHost } from '../validate'
import type { Vault } from '../vault'

export interface Endpoint {
  address: string
  port: number
  username: string
  password?: string
  keyFile?: string
  // set when the source tries agents whatever else the host has
  useAgent?: boolean
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
      const fields = await readKeyFile(file)
      const same = [...existing.keys, ...keys].find((k) => sameKey(k, fields))
      if (same) keyId = same.id
      else {
        const now = Date.now()
        keys.push({ ...fields, id: vault.newId(), createdAt: now, updatedAt: now })
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
      useAgent: e.useAgent ?? (!keyId && !e.password)
    })
  }

  const findEndpoint = (e: Endpoint): Host | undefined => [...existing.hosts, ...hosts].find((h) => sameEndpoint(h, e))

  const made = new Map<Found, Host>()
  // a skipped duplicate still answers for its label, so jumps that name it reach the host already there
  const byLabel = new Map<string, Host>()
  const rekeyed = new Map<string, string>()
  for (const f of scan.hosts) {
    const stored = existing.hosts.find((h) => sameEndpoint(h, f))
    const match = stored ?? hosts.find((h) => sameEndpoint(h, f))
    if (match) {
      byLabel.set(f.label, match)
      // a host saved without the key its source names gets that key, so importing again repairs it
      const keyId = stored && !stored.keyId && !stored.identityId && f.keyFile ? await loadKey(f.keyFile, f.label) : ''
      if (stored && keyId) rekeyed.set(stored.id, keyId)
      const why = keyId ? 'already in the vault, its key was added' : stored ? 'already in the vault' : 'same server as another entry in this import'
      summary.skipped.push(`${f.label}: ${why}`)
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

  if (hosts.length || keys.length || rekeyed.size) {
    await vault.mutate((d) => {
      d.keys.push(...keys)
      for (const h of d.hosts) {
        const keyId = rekeyed.get(h.id)
        if (!keyId) continue
        h.keyId = keyId
        h.updatedAt = Date.now()
      }
      d.hosts.push(...hosts)
    })
  }
  summary.hosts = hosts.length
  summary.keys = keys.length
  return summary
}
