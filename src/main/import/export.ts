import type { Host, VaultData } from '@shared/types'

const alias = (h: Host): string => (h.label || h.address).trim().replace(/\s+/g, '-').replace(/[^\w.@+-]/g, '') || h.address

// one Host block per SSH host; keys and passwords stay in the vault, so a key is named in a comment only
export function hostsToSshConfig(data: VaultData): string {
  const hosts = data.hosts.filter((h) => h.kind === 'ssh')
  const names = new Map<string, string>()
  const taken = new Set<string>()
  for (const h of hosts) {
    const base = alias(h)
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`
    taken.add(name.toLowerCase())
    names.set(h.id, name)
  }
  const out = [`# Exported from bawkterm on ${new Date().toISOString().slice(0, 10)}. Keys and passwords are not included.`, '']
  for (const h of hosts) {
    const identity = data.identities.find((i) => i.id === h.identityId)
    const key = data.keys.find((k) => k.id === (h.keyId || identity?.keyId))
    const user = h.username || identity?.username
    out.push(`Host ${names.get(h.id)}`, `  HostName ${h.address}`)
    if (user) out.push(`  User ${user}`)
    if (h.port !== 22) out.push(`  Port ${h.port}`)
    const jump = h.jumpHostId && names.get(h.jumpHostId)
    if (jump) out.push(`  ProxyJump ${jump}`)
    if (key) out.push(`  # key in bawkterm: ${key.label}${key.fingerprint ? ` (${key.fingerprint})` : ''}`)
    out.push('')
  }
  return out.join('\n')
}
