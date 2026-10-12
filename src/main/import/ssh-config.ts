import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { Endpoint, Found, Scan } from './commit'
import { expandHome } from './text'

interface Block {
  patterns: string[]
  opts: [string, string][]
}

export const SSH_CONFIG = join(homedir(), '.ssh', 'config')
// what ssh tries, in its order, for a host with no IdentityFile; security key files need their device, so agents cover those
const DEFAULT_KEYS = ['id_rsa', 'id_ecdsa', 'id_ed25519']

function parse(text: string): Block[] {
  // options above the first Host line apply to every host
  let current: Block = { patterns: ['*'], opts: [] }
  const blocks = [current]
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(\S+?)\s*[=\s]\s*(.+)$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host' || key === 'match') {
      current = { patterns: key === 'host' ? value.split(/\s+/) : [], opts: [] }
      blocks.push(current)
    } else {
      current.opts.push([key, value])
    }
  }
  return blocks
}

const glob = (pattern: string): RegExp =>
  new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')

// like ssh: a Host line applies when one of its patterns matches and none of its "!" patterns do
const applies = (b: Block, alias: string): boolean =>
  b.patterns.some((p) => !p.startsWith('!') && glob(p).test(alias)) &&
  !b.patterns.some((p) => p.startsWith('!') && glob(p.slice(1)).test(alias))

// every block that applies counts, top to bottom: ssh keeps the first value of an option and every IdentityFile
function optionsFor(blocks: Block[], alias: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const b of blocks) {
    if (!applies(b, alias)) continue
    for (const [key, value] of b.opts) out.set(key, [...(out.get(key) ?? []), value])
  }
  return out
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
  const aliases = new Set(blocks.flatMap((b) => b.patterns).filter((p) => !/[*?!]/.test(p)))
  const defaults = DEFAULT_KEYS.map((name) => join(homedir(), '.ssh', name)).filter((f) => existsSync(f))
  const scan: Scan = { hosts: [], skipped: [] }
  let guessed = false

  for (const alias of aliases) {
    const opts = optionsFor(blocks, alias)
    const opt = (key: string): string | undefined => opts.get(key)?.[0]
    const address = (opt('hostname') ?? alias).replace(/%h/g, alias)
    const port = Number(opt('port') ?? 22)
    const username = opt('user') ?? ''
    const tokens: Record<string, string> = { '%': '%', d: homedir(), h: address, n: alias, p: String(port), r: username }
    const named = (opts.get('identityfile') ?? [])
      .filter((f) => f.toLowerCase() !== 'none')
      .map((f) => expandHome(f.replace(/%([%dhnpr])/g, (_, token: string) => tokens[token])))
    const keys = named.length ? named : defaults
    guessed ||= !named.length
    const found: Found = {
      label: alias,
      address,
      port,
      username,
      group: 'ssh config',
      keyFile: keys.find((f) => existsSync(f)) ?? keys[0],
      useAgent: named.length ? undefined : true
    }
    const jump = opt('proxyjump')
    if (jump && jump !== 'none') {
      const first = jump.split(',')[0].trim()
      const target = hop(first)
      if (aliases.has(first)) found.jump = { label: first }
      else if (target && aliases.has(target.address) && !target.username) found.jump = { label: target.address }
      else if (target) found.jump = target
      else scan.skipped.push(`${alias}: jump host "${first}" not understood`)
    }
    scan.hosts.push(found)
  }
  if (guessed && defaults.length > 1) {
    const [used, ...others] = defaults.map((f) => basename(f))
    scan.skipped.push(`Hosts with no IdentityFile use ${used}. ssh also tries ${others.join(' and ')}: pick another key on the host if a login fails.`)
  }
  return scan
}
