import { isIP } from 'node:net'
import type { ServerSyncConfig, SyncState } from '@shared/types'
import { MARKER_ID } from './cipher'
import type { Pulled, Transport, WireRecord } from './transport'

const PAGE = 500
const MAX_PAGES = 1000
const MAX_RESPONSE = 64 * 1024 * 1024
const PUSH_CHUNK = 200

interface RemoteRecord extends WireRecord {
  seq: number
}

// plain http only to addresses that cannot be on the public internet; names are not trusted, only IP literals
function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost') return true
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
  }
  if (isIP(h) === 6) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h)
  return false
}

export function normalizeServerUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('Enter the full server address, for example https://sync.example.com')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) {
    throw new Error('Use https:// for servers outside your local network')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

export async function request<T>(config: ServerSyncConfig, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(config.url + path, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code
    throw new Error(`Cannot reach the sync server${cause ? ` (${cause})` : ''}`)
  }
  if (res.status === 401) throw new Error('The sync server rejected the token')
  if (!res.ok) throw Object.assign(new Error(`Sync server error ${res.status}`), { status: res.status })
  if (Number(res.headers.get('content-length') ?? 0) > MAX_RESPONSE) throw new Error('The sync server sent too much data')
  const text = await res.text()
  if (text.length > MAX_RESPONSE) throw new Error('The sync server sent too much data')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('The sync server sent an invalid answer')
  }
}

export async function checkServer(config: ServerSyncConfig): Promise<number> {
  const health = await request<{ name?: string }>(config, 'GET', '/v1/health')
  if (health.name !== 'bawksync') throw new Error('That address is not a bawksync server')
  const info = await request<{ records: number }>(config, 'GET', '/v1/info')
  return info.records
}

export async function eraseServer(config: ServerSyncConfig): Promise<void> {
  await request(config, 'DELETE', '/v1/records').catch((err) => {
    const status = (err as { status?: number }).status
    throw status === 404 || status === 405 ? new Error('This bawksync server is too old to erase its copy. Update it, then try again.') : err
  })
}

export async function firstRecord(config: ServerSyncConfig): Promise<{ id: string; blob: string } | undefined> {
  const first = await request<{ records: RemoteRecord[] }>(config, 'GET', '/v1/records?since=0&limit=1')
  return first.records?.[0]
}

export class ServerTransport implements Transport {
  constructor(private readonly config: ServerSyncConfig) {}

  async pull(sync: SyncState): Promise<Pulled> {
    let since = sync.lastSeq
    const records: { id: string; blob: string }[] = []
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES) throw new Error('The sync server keeps sending more pages')
      const page = await request<{ records: RemoteRecord[]; seq: number; more: boolean }>(
        this.config,
        'GET',
        `/v1/records?since=${since}&limit=${PAGE}`
      )
      if (!Array.isArray(page?.records) || !Number.isSafeInteger(page.seq) || page.seq < since) {
        throw new Error('The sync server sent an invalid answer')
      }
      if (page.more && page.seq === since) throw new Error('The sync server sent an invalid answer')
      for (const r of page.records) records.push(r)
      since = page.seq
      if (!page.more) break
    }
    const seq = since
    return {
      records,
      fresh: sync.lastSeq === 0 && seq > 0,
      moved: seq !== sync.lastSeq,
      commit: (s) => (s.lastSeq = seq)
    }
  }

  async push(records: WireRecord[]): Promise<string[]> {
    const rejected: string[] = []
    for (let i = 0; i < records.length; i += PUSH_CHUNK) {
      const res = await request<{ rejected: string[] }>(this.config, 'POST', '/v1/records', { records: records.slice(i, i + PUSH_CHUNK) })
      rejected.push(...res.rejected)
    }
    return rejected
  }

  async mark(blob: string): Promise<void> {
    await request(this.config, 'POST', '/v1/records', { records: [{ id: MARKER_ID, updatedAt: Date.now(), deleted: false, blob }] })
  }

  rewind(sync: SyncState): void {
    sync.lastSeq = 0
  }

  settle(): void {}
}
