import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { emptySync } from '@shared/defaults'
import type { SyncConfig, SyncPhase, SyncStatus, VaultData } from '@shared/types'
import type { Send } from './prompts'
import type { Vault } from './vault'
import { cleanHost, cleanIdentity, cleanKey, cleanKnownHost, cleanSnippet } from './validate'

const PAGE = 500
const MAX_PAGES = 1000
const MAX_RESPONSE = 64 * 1024 * 1024
const PAD = 1024
const PUSH_CHUNK = 200
const FOCUS_THROTTLE_MS = 60_000
const RETRY_MS = [30_000, 60_000, 120_000, 300_000]
const LINK_PREFIX = 'bawksync:'
// A record under this fixed, readable id, encrypted with the space's key. A device that finds one it cannot
// decrypt knows another device erased the space and started over with a new key.
const MARKER_ID = 'space'
const RESET_MESSAGE = 'Sync was reset from another device. Choose Stop syncing, then join again with the new sync link.'

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

  // padded to whole KiB so the server learns less about what each record holds
  seal(id: string, payload: Payload): string {
    const json = JSON.stringify(payload)
    const padded = json + ' '.repeat((PAD - (Buffer.byteLength(json) % PAD)) % PAD)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.enc, iv, { authTagLength: 16 })
    cipher.setAAD(Buffer.from(id))
    const body = Buffer.concat([cipher.update(padded, 'utf8'), cipher.final()])
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
  }

  // returns null for anything that does not decrypt or does not belong under this id
  open(id: string, blob: string): Payload | null {
    const payload = this.decrypt(id, blob)
    if (!payload) return null
    const expected = Buffer.from(this.id(payload.k))
    const actual = Buffer.from(id)
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? payload : null
  }

  sealMarker(): string {
    return this.seal(MARKER_ID, { k: MARKER_ID, v: null, t: Date.now() })
  }

  ownsMarker(blob: string): boolean {
    return this.decrypt(MARKER_ID, blob)?.k === MARKER_ID
  }

  private decrypt(id: string, blob: string): Payload | null {
    const raw = Buffer.from(blob, 'base64url')
    if (raw.length < 28) return null
    const decipher = createDecipheriv('aes-256-gcm', this.enc, raw.subarray(0, 12), { authTagLength: 16 })
    decipher.setAAD(Buffer.from(id))
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    let payload: Payload
    try {
      const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
      payload = JSON.parse(text) as Payload
    } catch {
      return null
    }
    return typeof payload?.k === 'string' && Number.isSafeInteger(payload.t) ? payload : null
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

// items from other devices are validated like local input; anything malformed or filed under the wrong id is ignored
function applyItem(d: VaultData, rkey: string, value: unknown): boolean {
  const [kind, ...rest] = rkey.split(':')
  const id = rest.join(':')
  try {
    switch (kind) {
      case 'host': {
        const incoming = cleanHost(value)
        if (incoming.id !== id) return false
        const lastUsedAt = d.hosts.find((h) => h.id === id)?.lastUsedAt
        upsert(d.hosts, { ...incoming, lastUsedAt })
        return true
      }
      case 'key': {
        const key = cleanKey(value)
        if (key.id !== id) return false
        upsert(d.keys, key)
        return true
      }
      case 'identity': {
        const identity = cleanIdentity(value)
        if (identity.id !== id) return false
        upsert(d.identities, identity)
        return true
      }
      case 'snippet': {
        const snippet = cleanSnippet(value)
        if (snippet.id !== id) return false
        upsert(d.snippets, snippet)
        return true
      }
      case 'known': {
        const k = cleanKnownHost(value)
        if (`${k.host}|${k.keyType}` !== id) return false
        d.knownHosts = d.knownHosts.filter((x) => !(x.host === k.host && x.keyType === k.keyType))
        d.knownHosts.push(k)
        return true
      }
    }
  } catch {
    // malformed item
  }
  return false
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

async function checkServer(config: SyncConfig): Promise<number> {
  const health = await request<{ name?: string }>(config, 'GET', '/v1/health')
  if (health.name !== 'bawksync') throw new Error('That address is not a bawksync server')
  const info = await request<{ records: number }>(config, 'GET', '/v1/info')
  return info.records
}

export class SyncEngine {
  private running: Promise<void> | null = null
  private again = false
  private rejections = 0
  private debounce?: NodeJS.Timeout
  private retry?: NodeJS.Timeout
  private active = false
  private failures = 0
  private phase: SyncPhase = 'off'
  private error?: string
  private lastRun = 0
  private lastSyncAt?: number

  constructor(
    private vault: Vault,
    private send: Send
  ) {
    vault.onChange((data) => this.onVaultChange(data))
    if (vault.unlocked) this.onVaultChange(vault.get())
  }

  status(): SyncStatus {
    const sync = this.vault.unlocked ? this.vault.get().sync : undefined
    return {
      phase: sync?.config ? this.phase : 'off',
      lastSyncAt: this.lastSyncAt ?? sync?.lastSyncAt,
      error: this.error ?? sync?.lastError
    }
  }

  private emit(phase: SyncPhase, error?: string): void {
    this.phase = phase
    this.error = error
    this.send('sync:status', this.status())
  }

  private onVaultChange(data: VaultData | null): void {
    if (!data?.sync.config) {
      clearTimeout(this.debounce)
      clearTimeout(this.retry)
      this.active = false
      this.failures = 0
      if (this.phase !== 'off') this.emit('off')
      return
    }
    if (!this.active) {
      this.active = true
      if (this.phase === 'off') this.phase = 'idle'
      this.schedule(300)
    } else if (pendingChanges(data).length) {
      this.schedule(1500)
    }
  }

  // the server cannot notify us, so returning to the window is when other devices' changes get pulled
  poke(): void {
    if (this.active && Date.now() - this.lastRun > FOCUS_THROTTLE_MS) this.schedule(0)
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
      this.rejections = 0
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
      const incoming: Payload[] = []
      let unreadable = 0
      for (let pages = 0; ; pages++) {
        if (pages >= MAX_PAGES) throw new Error('The sync server keeps sending more pages')
        const page = await request<{ records: RemoteRecord[]; seq: number; more: boolean }>(
          config,
          'GET',
          `/v1/records?since=${since}&limit=${PAGE}`
        )
        if (!Array.isArray(page?.records) || !Number.isSafeInteger(page.seq) || page.seq < since) {
          throw new Error('The sync server sent an invalid answer')
        }
        if (page.more && page.seq === since) throw new Error('The sync server sent an invalid answer')
        for (const r of page.records) {
          if (r?.id === MARKER_ID) {
            // stop before pushing, so this device's key never mixes into a space another device took over
            if (typeof r.blob !== 'string' || !cipher.ownsMarker(r.blob)) throw new Error(RESET_MESSAGE)
            continue
          }
          const payload = typeof r?.id === 'string' && typeof r.blob === 'string' ? cipher.open(r.id, r.blob) : null
          if (payload) incoming.push(payload)
          else unreadable++
        }
        since = page.seq
        if (!page.more) break
      }
      if (unreadable && !incoming.length && since > 0 && this.vault.get().sync.lastSeq === 0) {
        throw new Error('Sync key does not match the data on the server')
      }

      if (incoming.length || since !== this.vault.get().sync.lastSeq) {
        await this.vault.mutate((d) => {
          if (!sameConfig(d)) return
          const items = localItems(d)
          for (const { k: rkey, v, t } of incoming) {
            if (d.sync.synced[rkey] === t) continue
            const local = items.get(rkey)
            // deletion is decided by the encrypted payload only; the server's plain "deleted" flag is not trusted
            if (v === null) {
              if (local && local.updatedAt <= t) removeItem(d, rkey)
              if (!local || local.updatedAt <= t) {
                delete d.sync.synced[rkey]
                d.sync.tombstones[rkey] = Math.max(t, d.sync.tombstones[rkey] ?? 0)
              }
            } else if ((d.sync.tombstones[rkey] ?? -1) >= t) {
              continue
            } else if (!local || local.updatedAt <= t) {
              if (!applyItem(d, rkey, v)) continue
              d.sync.synced[rkey] = t
              delete d.sync.tombstones[rkey]
            }
          }
          d.sync.lastSeq = since
        })
      }

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

      // written after this device's own items, so bawkterm 0.4 devices that sample the first record can still join
      const marking = !this.vault.get().sync.marked
      if (marking) {
        await request(config, 'POST', '/v1/records', {
          records: [{ id: MARKER_ID, updatedAt: Date.now(), deleted: false, blob: cipher.sealMarker() }]
        })
      }

      this.lastSyncAt = Date.now()
      if (accepted.length || rejected.length || marking || this.vault.get().sync.lastError) {
        await this.vault.mutate((d) => {
          if (!sameConfig(d)) return
          d.sync.marked = true
          for (const c of accepted) {
            if (c.value === null) {
              delete d.sync.synced[c.rkey]
              d.sync.tombstones[c.rkey] = c.updatedAt
            } else {
              d.sync.synced[c.rkey] = c.updatedAt
              delete d.sync.tombstones[c.rkey]
            }
          }
          if (rejected.length) {
            for (const rkey of rejected) delete d.sync.synced[rkey]
            d.sync.lastSeq = 0
            this.again = true
          }
          d.sync.lastSyncAt = this.lastSyncAt
          d.sync.lastError = undefined
        })
      }
      // a server that rejects every push would otherwise loop forever re-pulling everything
      if (this.again && ++this.rejections > 2) throw new Error('The sync server keeps rejecting changes from this device')
      this.failures = 0
      clearTimeout(this.retry)
      this.emit('idle')
    } catch (err) {
      const message = (err as Error).message
      if (this.vault.unlocked && this.vault.get().sync.lastError !== message) {
        await this.vault
          .mutate((d) => {
            if (d.sync.config) d.sync.lastError = message
          })
          .catch(() => {})
      }
      this.again = false
      if (this.active) {
        clearTimeout(this.retry)
        this.retry = setTimeout(() => this.schedule(0), RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)])
        this.failures++
      }
      this.emit(this.vault.unlocked ? 'error' : 'off', message)
      throw err
    }
  }

  // how many records the server already holds for this token, so the window can offer to erase them first
  async check(rawUrl: string, token: string): Promise<number> {
    if (!token.trim()) throw new Error('Enter the server token')
    return checkServer({ url: normalizeServerUrl(rawUrl), token: token.trim(), key: '' })
  }

  async create(rawUrl: string, token: string, erase = false): Promise<void> {
    const config: SyncConfig = { url: normalizeServerUrl(rawUrl), token: token.trim(), key: randomBytes(32).toString('base64url') }
    if (!config.token) throw new Error('Enter the server token')
    const existing = await checkServer(config)
    if (existing > 0 && !erase) {
      throw new Error(
        'This server already holds a synced vault for that token. On a device that already syncs, copy its sync link and use "Join" instead.'
      )
    }
    if (existing > 0) {
      await request(config, 'DELETE', '/v1/records').catch((err) => {
        const status = (err as { status?: number }).status
        throw status === 404 || status === 405 ? new Error('This bawksync server is too old to erase its copy. Update it, then try again.') : err
      })
    }
    await this.vault.mutate((d) => {
      d.sync = { ...emptySync(), config }
    })
    await this.syncNow()
  }

  async join(link: string): Promise<void> {
    const config = decodeLink(link)
    const cipher = new RecordCipher(config.key)
    await checkServer(config)
    const first = await request<{ records: RemoteRecord[] }>(config, 'GET', '/v1/records?since=0&limit=1')
    const sample = first.records?.[0]
    if (sample && !(sample.id === MARKER_ID ? cipher.ownsMarker(sample.blob) : cipher.open(sample.id, sample.blob))) {
      throw new Error('Sync key does not match the data on the server')
    }
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
