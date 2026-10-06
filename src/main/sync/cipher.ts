import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FolderSyncConfig, SyncConfig } from '@shared/types'

const PAD = 1024
// A record under this fixed, readable id, encrypted with the space's key. A device that finds one it cannot
// decrypt knows another device erased the space and started over with a new key.
export const MARKER_ID = 'space'

export interface Payload {
  k: string
  v: unknown
  t: number
}

export class RecordCipher {
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

export const newSyncKey = (): string => randomBytes(32).toString('base64url')

export const isFolder = (config: SyncConfig): config is FolderSyncConfig => 'kind' in config && config.kind === 'folder'
