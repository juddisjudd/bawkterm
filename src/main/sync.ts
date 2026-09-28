import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { emptySync } from '@shared/defaults'
import type { SyncConfig, SyncPhase, SyncStatus, VaultData } from '@shared/types'
import type { Send } from './prompts'
import type { Vault } from './vault'

const PAGE = 500
const PUSH_CHUNK = 200
const INTERVAL_MS = 60_000
const FOCUS_THROTTLE_MS = 15_000
const LINK_PREFIX = 'bawksync:'

interface RemoteRecord {
  id: string
  seq: number
  updatedAt: number
  deleted: boolean
  blob: string
}

interface Payload {
  k: string
  v: unknown
  t: number
}

interface LocalItem {
  updatedAt: number
  value: unknown
}

interface Change {
  rkey: string
  updatedAt: number
  value: unknown
}

class RecordCipher {
  private enc: Buffer
  private mac: Buffer

  constructor(key: string) {
    const master = Buffer.from(key, 'base64url')
    if (master.length !== 32) throw new Error('Sync key is malformed')
    this.enc = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'bawksync/record-enc', 32))
    this.mac = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'bawksync/record-id', 32))
  }

  id(rkey: string): string {
    return createHmac('sha256', this.mac).update(rkey).digest('base64url')
  }

  seal(id: string, payload: Payload): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.enc, iv)
    cipher.setAAD(Buffer.from(id))
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
  }

  open(id: string, blob: string): Payload {
    const raw = Buffer.from(blob, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', this.enc, raw.subarray(0, 12))
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    try {
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
      return JSON.parse(text) as Payload
    } catch {
      throw new Error('Sync key does not match the data on the server')
    }
  }
}

function localItems(d: VaultData): Map<string, LocalItem> {
  const items = new Map<string, LocalItem>()
  for (const h of d.hosts) {
    const { lastUsedAt: _, ...value } = h
    items.set(`host:${h.id}`, { updatedAt: h.updatedAt, value })
  }
  for (const k of d.keys) items.set(`key:${k.id}`, { updatedAt: k.updatedAt, value: k })
  for (const i of d.identities) items.set(`identity:${i.id}`, { updatedAt: i.updatedAt, value: i })
  for (const s of d.snippets) items.set(`snippet:${s.id}`, { updatedAt: s.updatedAt, value: s })
  for (const k of d.knownHosts) items.set(`known:${k.host}|${k.keyType}`, { updatedAt: k.addedAt, value: k })
  return items
}

function upsert<T extends { id: string }>(list: T[], value: T): void {
  const i = list.findIndex((x) => x.id === value.id)
  if (i >= 0) list[i] = value
  else list.push(value)
}

function applyItem(d: VaultData, rkey: string, value: unknown): void {
  const [kind, ...rest] = rkey.split(':')
  const id = rest.join(':')
  switch (kind) {
    case 'host': {
      const incoming = value as VaultData['hosts'][number]
      const lastUsedAt = d.hosts.find((h) => h.id === id)?.lastUsedAt
      upsert(d.hosts, { ...incoming, tags: incoming.tags ?? [], lastUsedAt })
      break
    }
    case 'key':
      upsert(d.keys, value as VaultData['keys'][number])
      break
    case 'identity':
      upsert(d.identities, value as VaultData['identities'][number])
      break
    case 'snippet':
      upsert(d.snippets, value as VaultData['snippets'][number])
      break
    case 'known': {
      const k = value as VaultData['knownHosts'][number]
      d.knownHosts = d.knownHosts.filter((x) => !(x.host === k.host && x.keyType === k.keyType))
      d.knownHosts.push(k)
      break
    }
  }
}

function removeItem(d: VaultData, rkey: string): void {
  const [kind, ...rest] = rkey.split(':')
  const id = rest.join(':')
  switch (kind) {
    case 'host':
      d.hosts = d.hosts.filter((h) => h.id !== id)
      break
    case 'key':
      d.keys = d.keys.filter((k) => k.id !== id)
      break
    case 'identity':
      d.identities = d.identities.filter((i) => i.id !== id)
      break
    case 'snippet':
      d.snippets = d.snippets.filter((s) => s.id !== id)
      break
    case 'known':
      d.knownHosts = d.knownHosts.filter((k) => `${k.host}|${k.keyType}` !== id)
      break
  }
}

function pendingChanges(d: VaultData): Change[] {
  const items = localItems(d)
  const synced = d.sync.synced
  const changes: Change[] = []
  for (const [rkey, item] of items) {
    if (!(rkey in synced) || item.updatedAt > synced[rkey]) changes.push({ rkey, updatedAt: item.updatedAt, value: item.value })
  }
  const now = Date.now()
  for (const rkey of Object.keys(synced)) {
    if (!items.has(rkey)) changes.push({ rkey, updatedAt: Math.max(now, synced[rkey] + 1), value: null })
  }
  return changes
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' ||
    h === '::1' ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
  )
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

export function encodeLink(config: SyncConfig): string {
  return LINK_PREFIX + Buffer.from(JSON.stringify({ u: config.url, t: config.token, k: config.key })).toString('base64url')
}

export function decodeLink(link: string): SyncConfig {
  const trimmed = link.trim()
  if (!trimmed.startsWith(LINK_PREFIX)) throw new Error('A sync link starts with "bawksync:"')
  try {
    const { u, t, k } = JSON.parse(Buffer.from(trimmed.slice(LINK_PREFIX.length), 'base64url').toString('utf8'))
    if (typeof u !== 'string' || typeof t !== 'string' || typeof k !== 'string') throw new Error()
    return { url: normalizeServerUrl(u), token: t, key: k }
  } catch (err) {
    throw new Error((err as Error).message || 'This sync link is damaged. Copy it again.')
  }
}

async function request<T>(config: SyncConfig, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(config.url + path, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000)
    })
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code
    throw new Error(`Cannot reach the sync server${cause ? ` (${cause})` : ''}`)
  }
  if (res.status === 401) throw new Error('The sync server rejected the token')
  if (!res.ok) throw new Error(`Sync server error ${res.status}`)
  return (await res.json()) as T
}

async function checkServer(config: SyncConfig): Promise<number> {
  const health = await request<{ name?: string }>(config, 'GET', '/v1/health')
  if (health.name !== 'bawksync') throw new Error('That address is not a bawksync server')
  const info = await request<{ records: number }>(config, 'GET', '/v1/info')
  return info.records
}

export class SyncEngine {
  private running: Promise<void> | null = null
  private again = false
  private debounce?: NodeJS.Timeout
  private interval?: NodeJS.Timeout
  private phase: SyncPhase = 'off'
  private error?: string
  private lastRun = 0

  constructor(
    private vault: Vault,
    private send: Send
  ) {
    vault.onChange((data) => this.onVaultChange(data))
    if (vault.unlocked) this.onVaultChange(vault.get())
  }

  status(): SyncStatus {
    const sync = this.vault.unlocked ? this.vault.get().sync : undefined
    return { phase: sync?.config ? this.phase : 'off', lastSyncAt: sync?.lastSyncAt, error: this.error ?? sync?.lastError }
  }

  private emit(phase: SyncPhase, error?: string): void {
    this.phase = phase
    this.error = error
    this.send('sync:status', this.status())
  }

  private onVaultChange(data: VaultData | null): void {
    if (!data?.sync.config) {
      clearInterval(this.interval)
      clearTimeout(this.debounce)
      this.interval = undefined
      if (this.phase !== 'off') this.emit('off')
      return
    }
    if (!this.interval) {
      this.interval = setInterval(() => this.schedule(0), INTERVAL_MS)
      if (this.phase === 'off') this.phase = 'idle'
      this.schedule(300)
    } else if (pendingChanges(data).length) {
      this.schedule(1500)
    }
  }

  poke(): void {
    if (Date.now() - this.lastRun > FOCUS_THROTTLE_MS) this.schedule(0)
  }

  private schedule(ms: number): void {
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.syncNow().catch(() => {}), ms)
  }

  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.run()
        } while (this.again)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async run(): Promise<void> {
    if (!this.vault.unlocked) return
    const config = this.vault.get().sync.config
    if (!config) return
    this.lastRun = Date.now()
    this.emit('syncing')
    try {
      const cipher = new RecordCipher(config.key)
      const sameConfig = (d: VaultData): boolean => d.sync.config?.key === config.key && d.sync.config.url === config.url

      let since = this.vault.get().sync.lastSeq
      const incoming: { payload: Payload; deleted: boolean }[] = []
      for (;;) {
        const page = await request<{ records: RemoteRecord[]; seq: number; more: boolean }>(
          config,
          'GET',
          `/v1/records?since=${since}&limit=${PAGE}`
        )
        for (const r of page.records) incoming.push({ payload: cipher.open(r.id, r.blob), deleted: r.deleted })
        since = page.seq
        if (!page.more) break
      }

      await this.vault.mutate((d) => {
        if (!sameConfig(d)) return
        const items = localItems(d)
        for (const { payload, deleted } of incoming) {
          const { k: rkey, v, t } = payload
          if (d.sync.synced[rkey] === t) continue
          const local = items.get(rkey)
          if (deleted || v === null) {
            if (local && local.updatedAt <= t) removeItem(d, rkey)
            if (!local || local.updatedAt <= t) delete d.sync.synced[rkey]
          } else if (!local || local.updatedAt <= t) {
            applyItem(d, rkey, v)
            d.sync.synced[rkey] = t
          }
        }
        d.sync.lastSeq = since
      })

      const changes = pendingChanges(this.vault.get())
      const accepted: Change[] = []
      const rejected: string[] = []
      for (let i = 0; i < changes.length; i += PUSH_CHUNK) {
        const chunk = changes.slice(i, i + PUSH_CHUNK)
        const byId = new Map(chunk.map((c) => [cipher.id(c.rkey), c]))
        const records = [...byId].map(([id, c]) => ({
          id,
          updatedAt: c.updatedAt,
          deleted: c.value === null,
          blob: cipher.seal(id, { k: c.rkey, v: c.value, t: c.updatedAt })
        }))
        const res = await request<{ rejected: string[] }>(config, 'POST', '/v1/records', { records })
        const lost = new Set(res.rejected)
        for (const [id, c] of byId) (lost.has(id) ? rejected.push(c.rkey) : accepted.push(c))
      }

      await this.vault.mutate((d) => {
        if (!sameConfig(d)) return
        for (const c of accepted) {
          if (c.value === null) delete d.sync.synced[c.rkey]
          else d.sync.synced[c.rkey] = c.updatedAt
        }
        if (rejected.length) {
          for (const rkey of rejected) delete d.sync.synced[rkey]
          d.sync.lastSeq = 0
          this.again = true
        }
        d.sync.lastSyncAt = Date.now()
        d.sync.lastError = undefined
      })
      this.emit('idle')
    } catch (err) {
      const message = (err as Error).message
      if (this.vault.unlocked) {
        await this.vault
          .mutate((d) => {
            if (d.sync.config) d.sync.lastError = message
          })
          .catch(() => {})
      }
      this.again = false
      this.emit(this.vault.unlocked ? 'error' : 'off', message)
      throw err
    }
  }

  async create(rawUrl: string, token: string): Promise<void> {
    const config: SyncConfig = { url: normalizeServerUrl(rawUrl), token: token.trim(), key: randomBytes(32).toString('base64url') }
    if (!config.token) throw new Error('Enter the server token')
    const existing = await checkServer(config)
    if (existing > 0) {
      throw new Error(
        'This server already holds a synced vault for that token. On a device that already syncs, copy its sync link and use "Join" instead.'
      )
    }
    await this.vault.mutate((d) => {
      d.sync = { ...emptySync(), config }
    })
    await this.syncNow()
  }

  async join(link: string): Promise<void> {
    const config = decodeLink(link)
    new RecordCipher(config.key)
    await checkServer(config)
    const first = await request<{ records: RemoteRecord[] }>(config, 'GET', '/v1/records?since=0&limit=1')
    if (first.records[0]) new RecordCipher(config.key).open(first.records[0].id, first.records[0].blob)
    await this.vault.mutate((d) => {
      d.sync = { ...emptySync(), config }
    })
    await this.syncNow()
  }

  link(): string {
    const config = this.vault.get().sync.config
    if (!config) throw new Error('Sync is not set up')
    return encodeLink(config)
  }

  async disconnect(): Promise<void> {
    await this.vault.mutate((d) => {
      d.sync = emptySync()
    })
    this.error = undefined
    this.emit('off')
  }
}
