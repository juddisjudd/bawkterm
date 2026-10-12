import type { AdhocTarget, ConnectTarget, Host, VaultData } from '@shared/types'

export interface QuickArgs {
  address: string
  username: string
  port?: number
  key?: string
  jump?: string
  agentForward: boolean
  command: string
}

const WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g
const VALUE_OPTIONS = 'pliJ'
const USAGE = 'Use user@host:port. Options: -p port, -l user, -i key, -J jump host, -A.'

function portOf(text: string): number {
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${text}" is not a port`)
  return port
}

function endpoint(spec: string): Pick<QuickArgs, 'address' | 'username' | 'port'> {
  const m = spec.match(/^(?:(.+)@)?(?:\[([^\]\s]+)\]|([^\s:@[\]]+))(?::(\d+))?$/)
  if (!m) throw new Error(USAGE)
  return { username: m[1] ?? '', address: m[2] ?? m[3], port: m[4] ? portOf(m[4]) : undefined }
}

// reads the line the way ssh reads its arguments: options, the server, then a command to run there
export function parseQuick(text: string): QuickArgs {
  const words = (text.match(WORD) ?? []).map((w) => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2'))
  if (words[0] === 'ssh') words.shift()
  const q: QuickArgs = { address: '', username: '', agentForward: false, command: '' }
  let user = ''
  let port: number | undefined
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (!word.startsWith('-')) {
      if (q.address) {
        q.command = words.slice(i).join(' ')
        break
      }
      Object.assign(q, endpoint(word))
      continue
    }
    const option = word[1]
    if (word === '-A') {
      q.agentForward = true
      continue
    }
    if (!option || !VALUE_OPTIONS.includes(option)) throw new Error(`${word} is not supported. ${USAGE}`)
    const value = word.length > 2 ? word.slice(2) : words[++i]
    if (!value) throw new Error(`-${option} needs a value`)
    if (option === 'p') port = portOf(value)
    else if (option === 'l') user = value
    else if (option === 'i') q.key = value
    else q.jump = value
  }
  if (!q.address) throw new Error(USAGE)
  return { ...q, username: user || q.username, port: port ?? q.port }
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// a typed name or address of a saved host opens that host; options make a one-off connection that borrows its settings
export function quickTarget(q: QuickArgs, vault: VaultData, kind: Host['kind']): ConnectTarget {
  const hosts = vault.hosts.filter((h) => h.kind === kind)
  const identityOf = (h: Host) => vault.identities.find((i) => i.id === h.identityId)
  const userOf = (h: Host): string => h.username || identityOf(h)?.username || ''
  const agrees = (h: Host): boolean => (!q.username || userOf(h) === q.username) && (q.port === undefined || h.port === q.port)
  const saved = hosts.find((h) => same(h.label, q.address) && agrees(h)) ?? hosts.find((h) => same(h.address, q.address) && agrees(h))
  if (saved && !q.key && !q.jump && !q.agentForward) return { hostId: saved.id }

  const base = saved ?? hosts.find((h) => same(h.label, q.address))
  const adhoc: AdhocTarget = {
    address: base?.address ?? q.address,
    port: q.port ?? base?.port ?? (kind === 'rdp' ? 3389 : 22),
    username: q.username || (base ? userOf(base) : '')
  }
  const typedKey = q.key
  const stored = typedKey ? vault.keys.find((k) => same(k.label, typedKey)) : undefined
  const borrowed = base && (base.keyId || identityOf(base)?.keyId)
  if (stored) adhoc.keyId = stored.id
  else if (typedKey) adhoc.keyFile = typedKey
  else if (borrowed) adhoc.keyId = borrowed

  if (q.jump?.includes(',')) throw new Error('Only one jump host fits here. Save the hosts to chain more of them.')
  if (q.jump) adhoc.jump = quickTarget({ ...endpoint(q.jump), agentForward: false, command: '' }, vault, 'ssh')
  else if (base?.jumpHostId) adhoc.jump = { hostId: base.jumpHostId }
  if (q.agentForward || base?.agentForward) adhoc.agentForward = true
  return { adhoc }
}
