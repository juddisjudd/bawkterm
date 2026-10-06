import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Endpoint, Found, Scan } from './commit'
import { expandHome } from './text'

interface Block {
  alias: string
  opts: Map<string, string>
}

export const SSH_CONFIG = join(homedir(), '.ssh', 'config')

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

export const looksLikeSshConfig = (text: string): boolean => /^\s*Host\s+\S/im.test(text)

function hop(spec: string): Endpoint | null {
  const m = spec.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  return m ? { username: m[1] ?? '', address: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3] ?? 22) } : null
}

export async function countSshConfig(): Promise<number> {
  if (!existsSync(SSH_CONFIG)) return 0
  return (await scanSshConfig()).hosts.length
}

export async function scanSshConfig(file = SSH_CONFIG, text?: string): Promise<Scan> {
  if (text === undefined) {
    if (!existsSync(file)) throw new Error(`No SSH config found at ${file}`)
    text = await fsp.readFile(file, 'utf8')
  }
  const blocks = parse(text)
  const wildcard = blocks.find((b) => b.alias === '*')
  const concrete = blocks.filter((b) => !/[*?!]/.test(b.alias))
  const aliases = new Set(concrete.map((b) => b.alias))
  const opt = (b: Block, key: string): string | undefined => b.opts.get(key) ?? wildcard?.opts.get(key)
  const scan: Scan = { hosts: [], skipped: [] }

  for (const b of concrete) {
    const identity = opt(b, 'identityfile')
    const found: Found = {
      label: b.alias,
      address: opt(b, 'hostname') ?? b.alias,
      port: Number(opt(b, 'port') ?? 22),
      username: opt(b, 'user') ?? '',
      group: 'ssh config',
      keyFile: identity ? expandHome(identity) : undefined
    }
    const jump = opt(b, 'proxyjump')
    if (jump && jump !== 'none') {
      const first = jump.split(',')[0].trim()
      const target = hop(first)
      if (aliases.has(first)) found.jump = { label: first }
      else if (target && aliases.has(target.address) && !target.username) found.jump = { label: target.address }
      else if (target) found.jump = target
      else scan.skipped.push(`${b.alias}: jump host "${first}" not understood`)
    }
    scan.hosts.push(found)
  }
  return scan
}
