import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { blankHost } from '@shared/defaults'
import type { Host, ImportSummary, SshKey } from '@shared/types'
import { describeKey } from './keys'
import type { Vault } from './vault'

interface Block {
  alias: string
  opts: Map<string, string>
}

function parse(text: string): Block[] {
  const blocks: Block[] = []
  let current: Block[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(\S+?)\s*[=\s]\s*(.+)$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = value.split(/\s+/).map((alias) => ({ alias, opts: new Map() }))
      blocks.push(...current)
    } else if (key === 'match') {
      current = []
    } else {
      for (const b of current) if (!b.opts.has(key)) b.opts.set(key, value)
    }
  }
  return blocks
}

function expand(path: string): string {
  return resolve(path.replace(/^~(?=$|[\\/])/, homedir()))
}

export async function importSshConfig(vault: Vault): Promise<ImportSummary> {
  const file = join(homedir(), '.ssh', 'config')
  if (!existsSync(file)) throw new Error(`No SSH config found at ${file}`)
  const blocks = parse(await fsp.readFile(file, 'utf8'))
  const wildcard = blocks.filter((b) => /[*?!]/.test(b.alias))
  const concrete = blocks.filter((b) => !/[*?!]/.test(b.alias))
  const summary: ImportSummary = { hosts: 0, keys: 0, skipped: [] }

  const opt = (b: Block, key: string): string | undefined =>
    b.opts.get(key) ?? wildcard.find((w) => w.alias === '*')?.opts.get(key)

  const keyByPath = new Map<string, string>()
  const newKeys: SshKey[] = []
  const existingKeys = vault.get().keys

  for (const b of concrete) {
    const identity = opt(b, 'identityfile')
    if (!identity || keyByPath.has(identity)) continue
    const path = expand(identity)
    try {
      const fields = describeKey({ label: '', privateKey: await fsp.readFile(path, 'utf8'), passphrase: '' }, true)
      const dupe = existingKeys.find((k) => k.privateKey === fields.privateKey)
      if (dupe) {
        keyByPath.set(identity, dupe.id)
        continue
      }
      const key: SshKey = {
        ...fields,
        label: fields.encrypted ? path.split(/[\\/]/).pop()! : fields.label,
        id: vault.newId(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      newKeys.push(key)
      keyByPath.set(identity, key.id)
    } catch (err) {
      summary.skipped.push(`${identity}: ${(err as Error).message}`)
    }
  }

  const existingHosts = vault.get().hosts
  const byAlias = new Map<string, Host>()
  for (const b of concrete) {
    const address = opt(b, 'hostname') ?? b.alias
    const port = Number(opt(b, 'port') ?? 22)
    const username = opt(b, 'user') ?? ''
    if (existingHosts.some((h) => h.address === address && h.port === port && h.username === username)) {
      summary.skipped.push(`${b.alias}: already in vault`)
      continue
    }
    const identity = opt(b, 'identityfile')
    const host: Host = {
      ...blankHost(),
      id: vault.newId(),
      label: b.alias,
      address,
      port,
      username,
      group: 'ssh config',
      keyId: identity ? (keyByPath.get(identity) ?? '') : '',
      useAgent: !identity
    }
    byAlias.set(b.alias, host)
  }

  for (const b of concrete) {
    const jump = opt(b, 'proxyjump')
    const host = byAlias.get(b.alias)
    if (!jump || !host || jump === 'none') continue
    const first = jump.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '')
    const target = byAlias.get(first) ?? existingHosts.find((h) => h.label === first)
    if (target) host.jumpHostId = target.id
    else summary.skipped.push(`${b.alias}: jump host "${first}" not found`)
  }

  await vault.mutate((d) => {
    d.keys.push(...newKeys)
    d.hosts.push(...byAlias.values())
  })
  summary.hosts = byAlias.size
  summary.keys = newKeys.length
  return summary
}
