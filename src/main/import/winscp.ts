import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { Endpoint, Found, Scan } from './commit'
import { readRegistry, regNumber, regString, type RegTree, type RegValue } from './registry'
import { decodeText, parseIni, unescapePercent } from './text'

const WINSCP_KEY = 'HKCU\\Software\\Martin Prikryl\\WinSCP 2'
const SSH_PROTOCOLS = new Set([0, 1, 2])
const MAGIC = 0xa3
const FLAG = 0xff

export const winscpIni = (): string => join(process.env.APPDATA ?? '', 'WinSCP.ini')

// WinSCP obfuscates saved passwords with a fixed scheme, prefixed with user and host, unless a master password is set
export function decodeWinscpPassword(hex: string, username: string, host: string): string {
  let pos = 0
  const next = (): number => {
    if (pos + 2 > hex.length) throw new Error('truncated password')
    const byte = parseInt(hex.slice(pos, pos + 2), 16)
    pos += 2
    return ~(byte ^ MAGIC) & 0xff
  }
  const flag = next()
  let length = flag
  if (flag === FLAG) {
    next()
    length = next()
  }
  const skip = next()
  pos += skip * 2
  const bytes = Buffer.from(Array.from({ length }, next))
  const text = bytes.toString('utf8')
  const prefix = username + host
  return flag === FLAG && text.startsWith(prefix) ? text.slice(prefix.length) : text
}

type Values = Map<string, RegValue>

function session(name: string, v: Values, readPasswords: boolean, scan: Scan): void {
  const str = (key: string): string => unescapePercent(regString(v.get(key)))
  const address = str('HostName').trim()
  if (!address || regNumber(v.get('IsWorkspaceLink')) === 1) return
  const protocol = regNumber(v.get('FSProtocol')) ?? 1
  if (!SSH_PROTOCOLS.has(protocol)) {
    scan.skipped.push(`${name}: FTP, WebDAV and S3 sessions are not supported`)
    return
  }
  const password = (user: string, host: string, key: string): string | undefined => {
    const hex = regString(v.get(key))
    if (!hex || !readPasswords) return undefined
    try {
      return decodeWinscpPassword(hex, user, host)
    } catch {
      scan.skipped.push(`${name}: saved password could not be read`)
      return undefined
    }
  }
  const parts = name.split('/')
  const username = str('UserName')
  const found: Found = {
    label: parts.pop()!,
    address,
    port: regNumber(v.get('PortNumber')) || 22,
    username,
    password: password(username, address, 'Password'),
    group: parts.length ? parts.join(' / ') : 'WinSCP',
    keyFile: str('PublicKeyFile') || undefined
  }
  if (regNumber(v.get('Tunnel')) === 1 && str('TunnelHostName')) {
    const tunnel: Endpoint = {
      address: str('TunnelHostName').trim(),
      port: regNumber(v.get('TunnelPortNumber')) || 22,
      username: str('TunnelUserName'),
      keyFile: str('TunnelPublicKeyFile') || undefined
    }
    tunnel.password = password(tunnel.username, tunnel.address, 'TunnelPassword')
    found.jump = tunnel
  }
  scan.hosts.push(found)
}

function collect(entries: [string, Values][], masterPassword: boolean): Scan {
  const scan: Scan = { hosts: [], skipped: [] }
  for (const [name, values] of entries) session(unescapePercent(name), values, !masterPassword, scan)
  if (masterPassword && scan.hosts.length) {
    scan.skipped.push('Saved passwords are protected by your WinSCP master password, so they were not imported')
  }
  return scan
}

export function winscpFromIni(text: string): Scan {
  const sections = parseIni(text)
  const security = sections.find((s) => s.name === 'Configuration\\Security')
  const entries = sections
    .filter((s) => s.name.startsWith('Sessions\\'))
    .map((s): [string, Values] => [s.name.slice('Sessions\\'.length), s.values])
  return collect(entries, security?.values.get('UseMasterPassword') === '1')
}

export function winscpFromRegistry(tree: RegTree): Scan {
  return collect(
    [...tree].filter(([path]) => /^Sessions\\[^\\]+$/.test(path)).map(([path, v]) => [path.slice('Sessions\\'.length), v]),
    regNumber(tree.get('Configuration\\Security')?.get('UseMasterPassword')) === 1
  )
}

export async function scanWinscp(): Promise<Scan> {
  const fromRegistry = winscpFromRegistry(await readRegistry(WINSCP_KEY))
  if (!existsSync(winscpIni())) return fromRegistry
  const fromIni = winscpFromIni(decodeText(await fsp.readFile(winscpIni())))
  return { hosts: [...fromRegistry.hosts, ...fromIni.hosts], skipped: [...fromRegistry.skipped, ...fromIni.skipped] }
}
