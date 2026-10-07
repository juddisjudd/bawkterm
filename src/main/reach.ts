import { connect } from 'node:net'
import type { Host, HostReach } from '@shared/types'

const TIMEOUT_MS = 3000
const AT_ONCE = 16

const REASONS: Record<string, string> = {
  ECONNREFUSED: 'nothing is listening on that port',
  ENOTFOUND: 'the name does not resolve',
  EAI_AGAIN: 'the name does not resolve',
  EHOSTUNREACH: 'no route to the host',
  ENETUNREACH: 'no route to the network',
  ECONNRESET: 'the connection was reset'
}

function probe(address: string, port: number): Promise<HostReach> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = connect({ host: address, port })
    const done = (reach: HostReach): void => {
      socket.destroy()
      resolve(reach)
    }
    socket.setTimeout(TIMEOUT_MS, () => done({ up: false, reason: 'no answer within 3 seconds' }))
    socket.once('connect', () => done({ up: true, ms: Date.now() - started }))
    socket.once('error', (err: NodeJS.ErrnoException) => done({ up: false, reason: REASONS[err.code ?? ''] ?? err.message }))
  })
}

// only saved hosts are checked, so the window cannot point this at arbitrary addresses
export async function probeHosts(hosts: Host[]): Promise<Record<string, HostReach>> {
  const targets = hosts.filter((h) => h.address && !h.jumpHostId)
  const out: Record<string, HostReach> = {}
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const host = targets[next++]
      out[host.id] = await probe(host.address, host.port)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, targets.length) }, worker))
  return out
}
