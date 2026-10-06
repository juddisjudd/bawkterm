import { randomBytes } from 'node:crypto'
import { promises as fsp, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { FolderSyncConfig, SyncState } from '@shared/types'
import { writeFileAtomic } from '../files'
import { MARKER_ID } from './cipher'
import type { Pulled, Transport, WireRecord } from './transport'

// each device writes only its own file, so a sync service never sees two writers on one file or makes conflicted copies
const FORMAT = 'bawksync-folder'
const SPACE_FILE = 'space.bawksync'
const DEVICE_FILE = /^device-([A-Za-z0-9_-]{8,64})\.bawksync$/
const MAX_FILE = 64 * 1024 * 1024
const MAX_RECORDS = 100_000

interface SpaceFile {
  format: typeof FORMAT
  version: 1
  marker: string
}

interface DeviceFile {
  format: typeof FORMAT
  version: 1
  device: string
  // changes on every write, so the device can tell whether someone else wrote its file
  written: string
  records: Record<string, Omit<WireRecord, 'id'>>
}

export const newDeviceId = (): string => randomBytes(12).toString('base64url')
const deviceFile = (device: string): string => `device-${device}.bawksync`

const isRecord = (r: unknown): r is Omit<WireRecord, 'id'> => {
  const x = r as Partial<WireRecord> | null
  return !!x && Number.isSafeInteger(x.updatedAt) && typeof x.deleted === 'boolean' && typeof x.blob === 'string'
}

async function readJson<T>(path: string): Promise<T | 'missing' | 'damaged'> {
  try {
    const stat = await fsp.stat(path)
    if (stat.size > MAX_FILE) throw new Error(`${path} is too large to be a sync file`)
    const value = JSON.parse(await fsp.readFile(path, 'utf8')) as T
    return value && typeof value === 'object' ? value : 'damaged'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    if (err instanceof SyntaxError) return 'damaged'
    throw err
  }
}

const deviceRecords = (file: DeviceFile | 'missing' | 'damaged'): DeviceFile['records'] | null =>
  typeof file === 'object' && file.format === FORMAT && file.records && typeof file.records === 'object' ? file.records : null

async function listFolder(folder: string): Promise<string[]> {
  try {
    return await fsp.readdir(folder)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' || code === 'ENOTDIR' ? `The sync folder is not available: ${folder}` : (err as Error).message)
  }
}

export async function readMarker(folder: string): Promise<string | null> {
  const space = await readJson<SpaceFile>(join(folder, SPACE_FILE))
  return typeof space === 'object' && space.format === FORMAT && typeof space.marker === 'string' ? space.marker : null
}

// whether the folder already holds a synced vault, so setup can offer to join it or erase it first
export async function folderHolds(folder: string): Promise<boolean> {
  const names = await listFolder(folder)
  return names.some((n) => n === SPACE_FILE || DEVICE_FILE.test(n))
}

export async function eraseFolder(folder: string): Promise<void> {
  for (const name of await listFolder(folder)) {
    if (name === SPACE_FILE || DEVICE_FILE.test(name)) await fsp.rm(join(folder, name), { force: true })
  }
}

// a record from any device file, to check a sync key against a folder that has no marker yet
export async function sampleRecord(folder: string): Promise<{ id: string; blob: string } | undefined> {
  for (const name of await listFolder(folder)) {
    if (!DEVICE_FILE.test(name)) continue
    const records = deviceRecords(await readJson<DeviceFile>(join(folder, name)))
    const first = records && Object.entries(records).find(([, r]) => isRecord(r))
    if (first) return { id: first[0], blob: first[1].blob }
  }
  return undefined
}

export function watchFolder(folder: string, device: string, onChange: () => void): () => void {
  const own = deviceFile(device)
  let watcher: FSWatcher | undefined
  let poll: NodeJS.Timeout | undefined
  try {
    watcher = watch(folder, (_event, name) => {
      if (!name || name === SPACE_FILE || (DEVICE_FILE.test(name) && name !== own)) onChange()
    })
    watcher.on('error', () => {
      watcher?.close()
      poll ??= setInterval(onChange, 60_000)
    })
  } catch {
    // network shares and some cloud drives cannot be watched, so they are checked every minute instead
    poll = setInterval(onChange, 60_000)
  }
  return () => {
    watcher?.close()
    clearInterval(poll)
  }
}

export class FolderTransport implements Transport {
  private device: string
  private wrote?: string
  private moved = false

  constructor(private readonly config: FolderSyncConfig) {
    this.device = config.device
  }

  private path(name: string): string {
    return join(this.config.folder, name)
  }

  async pull(sync: SyncState): Promise<Pulled> {
    const names = await listFolder(this.config.folder)
    const records: { id: string; blob: string }[] = []
    const marker = names.includes(SPACE_FILE) ? await readMarker(this.config.folder) : null
    if (marker) records.push({ id: MARKER_ID, blob: marker })

    // a copied vault.json on another computer writes as this device too; this device then takes a new name
    const own = await readJson<DeviceFile>(this.path(deviceFile(this.device)))
    const renamed = own === 'damaged' || (typeof own === 'object' && own.written !== sync.folderWrote)
    if (renamed) {
      this.device = newDeviceId()
      this.moved = true
    }

    const seen = sync.folderSeen ?? {}
    const next: Record<string, string> = {}
    let count = 0
    for (const name of names) {
      const match = DEVICE_FILE.exec(name)
      if (!match || match[1] === this.device) continue
      let stamp: string
      try {
        const stat = await fsp.stat(this.path(name))
        stamp = `${stat.size}:${stat.mtimeMs}`
      } catch {
        continue
      }
      if (seen[name] === stamp) {
        next[name] = stamp
        continue
      }
      // a file the sync service is still downloading reads as damaged; it is read again on the next pass
      const fileRecords = deviceRecords(await readJson<DeviceFile>(this.path(name)))
      if (!fileRecords) continue
      for (const [id, r] of Object.entries(fileRecords)) {
        if (++count > MAX_RECORDS) throw new Error('The sync folder holds more records than bawkterm accepts')
        if (isRecord(r)) records.push({ id, blob: r.blob })
      }
      next[name] = stamp
    }

    const before = Object.keys(seen)
    const moved = this.moved || before.length !== Object.keys(next).length || before.some((n) => seen[n] !== next[n])
    const device = this.device
    return {
      records,
      fresh: !before.length,
      moved,
      commit: (s) => {
        s.folderSeen = next
        if (s.config && 'kind' in s.config && s.config.device !== device) {
          s.config.device = device
          s.folderWrote = undefined
          // the new file starts empty, so every item is sent again; known deletions stay listed and go too
          for (const rkey of Object.keys(s.synced)) s.synced[rkey] = -1
        }
      }
    }
  }

  async push(records: WireRecord[]): Promise<string[]> {
    if (!records.length) return []
    const name = deviceFile(this.device)
    const file: DeviceFile = {
      format: FORMAT,
      version: 1,
      device: this.device,
      written: '',
      records: deviceRecords(await readJson<DeviceFile>(this.path(name))) ?? {}
    }
    for (const r of records) {
      const held = file.records[r.id]
      if (!held || r.updatedAt > held.updatedAt) file.records[r.id] = { updatedAt: r.updatedAt, deleted: r.deleted, blob: r.blob }
    }
    file.written = randomBytes(9).toString('base64url')
    await writeFileAtomic(this.path(name), JSON.stringify(file))
    this.wrote = file.written
    return []
  }

  async mark(blob: string): Promise<void> {
    if (await readMarker(this.config.folder)) return
    const space: SpaceFile = { format: FORMAT, version: 1, marker: blob }
    await writeFileAtomic(this.path(SPACE_FILE), JSON.stringify(space))
  }

  rewind(sync: SyncState): void {
    sync.folderSeen = {}
  }

  settle(sync: SyncState): void {
    if (this.wrote) sync.folderWrote = this.wrote
  }
}
