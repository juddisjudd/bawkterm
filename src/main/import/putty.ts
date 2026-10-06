import type { Found, Scan } from './commit'
import { readRegistry, regNumber, regString, type RegTree } from './registry'
import { unescapePercent } from './text'

export const PUTTY_KEYS = {
  putty: 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions',
  kitty: 'HKCU\\Software\\9bis.com\\KiTTY\\Sessions'
} as const

const PROXY_SSH = 7

export function puttySessions(tree: RegTree, group: string): Scan {
  const scan: Scan = { hosts: [], skipped: [] }
  const sessions = [...tree].filter(([path]) => path && !path.includes('\\'))
  const names = new Set(sessions.map(([path]) => unescapePercent(path)))
  for (const [path, v] of sessions) {
    const name = unescapePercent(path)
    if (name === 'Default Settings') continue
    let address = regString(v.get('HostName')).trim()
    if (!address) continue
    const protocol = regString(v.get('Protocol')) || 'ssh'
    if (protocol !== 'ssh') {
      scan.skipped.push(`${name}: ${protocol} sessions are not supported`)
      continue
    }
    let username = regString(v.get('UserName'))
    const at = address.lastIndexOf('@')
    if (at > 0) {
      username ||= address.slice(0, at)
      address = address.slice(at + 1)
    }
    const found: Found = {
      label: name,
      address,
      port: regNumber(v.get('PortNumber')) || 22,
      username,
      group,
      keyFile: regString(v.get('PublicKeyFile')) || undefined
    }
    const proxy = regNumber(v.get('ProxyMethod')) ?? 0
    const proxyHost = regString(v.get('ProxyHost')).trim()
    // since PuTTY 0.77 an SSH proxy may name another saved session instead of a server
    if (proxy === PROXY_SSH && proxyHost) {
      found.jump = names.has(proxyHost)
        ? { label: proxyHost }
        : { address: proxyHost, port: regNumber(v.get('ProxyPort')) || 22, username: regString(v.get('ProxyUsername')) }
    } else if (proxy !== 0) {
      scan.skipped.push(`${name}: imported without its proxy settings`)
    }
    scan.hosts.push(found)
  }
  return scan
}

export async function scanPutty(which: keyof typeof PUTTY_KEYS): Promise<Scan> {
  return puttySessions(await readRegistry(PUTTY_KEYS[which]), which === 'putty' ? 'PuTTY' : 'KiTTY')
}
