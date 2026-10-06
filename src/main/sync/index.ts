import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { emptySync } from '@shared/defaults'
import type { FolderSyncConfig, ServerSyncConfig, SyncConfig, SyncPhase, SyncStatus, VaultData } from '@shared/types'
import type { Send } from '../prompts'
import type { Vault } from '../vault'
import { cleanHost, cleanIdentity, cleanKey, cleanKnownHost, cleanSnippet } from '../validate'
import { isFolder, MARKER_ID, newSyncKey, RecordCipher, type Payload } from './cipher'
import { eraseFolder, FolderTransport, folderHolds, newDeviceId, readMarker, sampleRecord, watchFolder } from './folder'
import { decodeLink } from './link'
import { checkServer, eraseServer, firstRecord, normalizeServerUrl, ServerTransport } from './server'
import type { Transport, WireRecord } from './transport'

export { encodeLink } from './link'

const FOCUS_THROTTLE_MS = 60_000
const FOLDER_SETTLE_MS = 2000
const RETRY_MS = [30_000, 60_000, 120_000, 300_000]
const RESET_MESSAGE = 'Sync was reset from another device. Choose Stop syncing, then join again with the new sync link.'

interface LocalItem {
  updatedAt: number
  value: unknown
}

interface Change {
  rkey: string
  updatedAt: number
  value: unknown
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

const transportFor = (config: SyncConfig): Transport => (isFolder(config) ? new FolderTransport(config) : new ServerTransport(config))

// the device name inside a folder config may change during a run, so only the key and the place identify a target
function sameTarget(a: SyncConfig | null, b: SyncConfig): boolean {
  if (!a || a.key !== b.key) return false
  return isFolder(a) ? isFolder(b) && a.folder === b.folder : !isFolder(b) && a.url === b.url
}

const keyMismatch = (config: SyncConfig): string =>
  `Sync key does not match the data ${isFolder(config) ? 'in the sync folder' : 'on the server'}`

async function assertWritable(folder: string): Promise<void> {
  const probe = join(folder, `.bawkterm-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(probe, '')
    await fsp.rm(probe, { force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? `The folder does not exist: ${folder}` : `bawkterm cannot write to ${folder}`)
  }
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
  private watching = ''
  private unwatch?: () => void

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
    const config = data?.sync.config
    this.watch(config && isFolder(config) ? config : null)
    if (!data || !config) {
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

  // other devices' files land in a sync folder at any time, so the folder is watched while sync is on
  private watch(config: FolderSyncConfig | null): void {
    const target = config ? `${config.folder}\n${config.device}` : ''
    if (target === this.watching) return
    this.unwatch?.()
    this.unwatch = config ? watchFolder(config.folder, config.device, () => this.schedule(FOLDER_SETTLE_MS)) : undefined
    this.watching = target
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
      const transport = transportFor(config)

      const pulled = await transport.pull(this.vault.get().sync)
      // several device files in a folder can hold the same item; only its newest copy is merged, a deletion winning ties
      const newest = new Map<string, Payload>()
      let unreadable = 0
      for (const r of pulled.records) {
        if (r?.id === MARKER_ID) {
          // stop before pushing, so this device's key never mixes into a space another device took over
          if (typeof r.blob !== 'string' || !cipher.ownsMarker(r.blob)) throw new Error(RESET_MESSAGE)
          continue
        }
        const payload = typeof r?.id === 'string' && typeof r.blob === 'string' ? cipher.open(r.id, r.blob) : null
        if (!payload) {
          unreadable++
          continue
        }
        const held = newest.get(payload.k)
        if (!held || payload.t > held.t || (payload.t === held.t && payload.v === null)) newest.set(payload.k, payload)
      }
      const incoming = [...newest.values()]
      if (unreadable && !incoming.length && pulled.fresh) throw new Error(keyMismatch(config))

      if (incoming.length || pulled.moved) {
        await this.vault.mutate((d) => {
          if (!sameTarget(d.sync.config, config)) return
          const items = localItems(d)
          for (const { k: rkey, v, t } of incoming) {
            if (d.sync.synced[rkey] === t) continue
            const local = items.get(rkey)
            // deletion is decided by the encrypted payload only; the backend's plain "deleted" flag is not trusted
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
          pulled.commit(d.sync)
        })
      }

      const changes = new Map(pendingChanges(this.vault.get()).map((c) => [cipher.id(c.rkey), c]))
      const records: WireRecord[] = [...changes].map(([id, c]) => ({
        id,
        updatedAt: c.updatedAt,
        deleted: c.value === null,
        blob: cipher.seal(id, { k: c.rkey, v: c.value, t: c.updatedAt })
      }))
      const lost = new Set(records.length ? await transport.push(records) : [])
      const accepted = [...changes].filter(([id]) => !lost.has(id)).map(([, c]) => c)
      const rejected = [...changes].filter(([id]) => lost.has(id)).map(([, c]) => c.rkey)

      // written after this device's own items, so bawkterm 0.4 devices that sample the first record can still join
      const marking = !this.vault.get().sync.marked
      if (marking) await transport.mark(cipher.sealMarker())

      this.lastSyncAt = Date.now()
      if (accepted.length || rejected.length || marking || this.vault.get().sync.lastError) {
        await this.vault.mutate((d) => {
          if (!sameTarget(d.sync.config, config)) return
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
          transport.settle(d.sync)
          if (rejected.length) {
            for (const rkey of rejected) delete d.sync.synced[rkey]
            transport.rewind(d.sync)
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

  private async start(config: SyncConfig): Promise<void> {
    await this.vault.mutate((d) => {
      d.sync = { ...emptySync(), config }
    })
    await this.syncNow()
  }

  // how many records the server already holds for this token, so the window can offer to erase them first
  async check(rawUrl: string, token: string): Promise<number> {
    if (!token.trim()) throw new Error('Enter the server token')
    return checkServer({ url: normalizeServerUrl(rawUrl), token: token.trim(), key: '' })
  }

  async create(rawUrl: string, token: string, erase = false): Promise<void> {
    const config: ServerSyncConfig = { url: normalizeServerUrl(rawUrl), token: token.trim(), key: newSyncKey() }
    if (!config.token) throw new Error('Enter the server token')
    const existing = await checkServer(config)
    if (existing > 0 && !erase) {
      throw new Error(
        'This server already holds a synced vault for that token. On a device that already syncs, copy its sync link and use "Join" instead.'
      )
    }
    if (existing > 0) await eraseServer(config)
    await this.start(config)
  }

  async join(link: string): Promise<void> {
    const parsed = decodeLink(link)
    if (!('server' in parsed)) throw new Error('This sync link is for a shared folder. Choose the folder to join it.')
    const config = parsed.server
    const cipher = new RecordCipher(config.key)
    await checkServer(config)
    const sample = await firstRecord(config)
    if (sample && !(sample.id === MARKER_ID ? cipher.ownsMarker(sample.blob) : cipher.open(sample.id, sample.blob))) {
      throw new Error(keyMismatch(config))
    }
    await this.start(config)
  }

  // whether a folder already holds a synced vault, so the window can offer to join it or erase it
  async inspectFolder(folder: string): Promise<boolean> {
    return folderHolds(folder)
  }

  async createFolder(folder: string, erase = false): Promise<void> {
    await assertWritable(folder)
    if (await folderHolds(folder)) {
      if (!erase) {
        throw new Error('This folder already holds a synced vault. On a device that already syncs, copy its sync link and use "Join" instead.')
      }
      await eraseFolder(folder)
    }
    await this.start({ kind: 'folder', folder, key: newSyncKey(), device: newDeviceId() })
  }

  async joinFolder(folder: string, link: string): Promise<void> {
    const parsed = decodeLink(link)
    if (!('folderKey' in parsed)) throw new Error('This sync link is for a bawksync server, not a shared folder.')
    const config: FolderSyncConfig = { kind: 'folder', folder, key: parsed.folderKey, device: newDeviceId() }
    await assertWritable(folder)
    const cipher = new RecordCipher(config.key)
    const marker = await readMarker(folder)
    const sample = marker ? undefined : await sampleRecord(folder)
    if (!marker && !sample) {
      throw new Error(
        'This folder holds no synced vault yet. Choose the folder your other device syncs to, or wait until your sync service has copied it here.'
      )
    }
    if (marker ? !cipher.ownsMarker(marker) : sample && !cipher.open(sample.id, sample.blob)) throw new Error(keyMismatch(config))
    await this.start(config)
  }

  async disconnect(): Promise<void> {
    await this.vault.mutate((d) => {
      d.sync = emptySync()
    })
    this.error = undefined
    this.emit('off')
  }
}
