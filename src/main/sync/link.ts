import type { ServerSyncConfig, SyncConfig } from '@shared/types'
import { isFolder, RecordCipher } from './cipher'
import { normalizeServerUrl } from './server'

const LINK_PREFIX = 'bawksync:'

export type SyncLink = { server: ServerSyncConfig } | { folderKey: string }

// a folder link carries only the key: every device picks its own copy of the shared folder
export function encodeLink(config: SyncConfig): string {
  const body = isFolder(config) ? { f: 1, k: config.key } : { u: config.url, t: config.token, k: config.key }
  return LINK_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url')
}

export function decodeLink(link: string): SyncLink {
  const trimmed = link.trim()
  if (!trimmed.startsWith(LINK_PREFIX)) throw new Error('A sync link starts with "bawksync:"')
  let body: { u?: unknown; t?: unknown; k?: unknown; f?: unknown }
  try {
    body = JSON.parse(Buffer.from(trimmed.slice(LINK_PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    throw new Error('This sync link is damaged. Copy it again.')
  }
  const { u, t, k, f } = body ?? {}
  if (typeof k !== 'string') throw new Error('This sync link is damaged. Copy it again.')
  new RecordCipher(k)
  if (f === 1) return { folderKey: k }
  if (typeof u !== 'string' || typeof t !== 'string') throw new Error('This sync link is damaged. Copy it again.')
  return { server: { url: normalizeServerUrl(u), token: t, key: k } }
}
