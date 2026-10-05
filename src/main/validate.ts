import { FOLDER_COLORS } from '@shared/defaults'
import type {
  ConnectTarget,
  DockerAction,
  DockerCommand,
  FolderColor,
  Host,
  Identity,
  KeyGenRequest,
  KeyGenType,
  KeyImportRequest,
  KnownHost,
  LocalState,
  PasskeyEnrollment,
  PromptResponse,
  SavedTab,
  Settings,
  Snippet,
  SshKey
} from '@shared/types'

// Everything arriving over IPC or from another device through sync is checked here before it is used or stored.

export class InvalidInput extends Error {}

const fail = (what: string): never => {
  throw new InvalidInput(`Invalid ${what}`)
}

const TIME_MAX = 8.64e15
const CONTROL = /[\x00-\x1f\x7f]/

export function text(v: unknown, what: string, max = 4096): string {
  return typeof v === 'string' && v.length <= max ? v : fail(what)
}

// single-line values end up in .rdp files, host key ids and shell commands, where a line break changes meaning
export function line(v: unknown, what: string, max = 1024): string {
  const s = text(v, what, max)
  return CONTROL.test(s) ? fail(what) : s
}

// remote file names may legally contain line breaks, but never NUL
export function path(v: unknown, what = 'path'): string {
  const s = text(v, what, 32767)
  return s.includes('\0') ? fail(what) : s
}

export function int(v: unknown, what: string, min: number, max: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(what)
}

export function num(v: unknown, what: string, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(what)
}

export function bool(v: unknown, what: string): boolean {
  return typeof v === 'boolean' ? v : fail(what)
}

export function oneOf<T extends string>(v: unknown, what: string, options: readonly T[]): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fail(what)
}

export function list<T>(v: unknown, what: string, max: number, item: (x: unknown) => T): T[] {
  return Array.isArray(v) && v.length <= max ? v.map(item) : fail(what)
}

function obj(v: unknown, what: string): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(what)
}

function record<T>(v: unknown, what: string, max: number, key: (k: string) => string, value: (x: unknown) => T): Record<string, T> {
  const entries = Object.entries(obj(v, what))
  if (entries.length > max) fail(what)
  return Object.fromEntries(entries.map(([k, x]) => [key(k), value(x)]))
}

export const id = (v: unknown, what = 'id'): string => line(v, what, 128)
const time = (v: unknown): number => int(v, 'date', 0, TIME_MAX)

const address = (v: unknown): string => {
  const s = line(v, 'address', 255).trim()
  return s && !/\s/.test(s) ? s : fail('address')
}

export function cleanHost(v: unknown): Host {
  const h = obj(v, 'host')
  const host: Host = {
    id: id(h.id ?? '', 'host id'),
    kind: oneOf(h.kind ?? 'ssh', 'host kind', ['ssh', 'rdp']),
    label: line(h.label ?? '', 'label', 256),
    address: address(h.address),
    port: int(h.port, 'port', 1, 65535),
    group: line(h.group ?? '', 'group', 128),
    username: line(h.username ?? '', 'username', 256),
    password: text(h.password ?? '', 'password'),
    keyId: id(h.keyId ?? '', 'key'),
    identityId: id(h.identityId ?? '', 'identity'),
    useAgent: bool(h.useAgent ?? false, 'agent setting'),
    jumpHostId: id(h.jumpHostId ?? '', 'jump host'),
    tags: list(h.tags ?? [], 'tags', 64, (t) => line(t, 'tag', 64)),
    notes: text(h.notes ?? '', 'notes', 20_000),
    createdAt: time(h.createdAt ?? 0),
    updatedAt: time(h.updatedAt ?? 0),
    rdpFullscreen: bool(h.rdpFullscreen ?? true, 'full screen setting'),
    startupCommand: text(h.startupCommand ?? '', 'startup command'),
    bookmarks: list(h.bookmarks ?? [], 'favorites', 500, (p) => path(p, 'favorite')),
    folderColors: record(h.folderColors ?? {}, 'folder colors', 2000, (k) => path(k, 'folder'), (c): FolderColor =>
      oneOf(c, 'folder color', FOLDER_COLORS)
    )
  }
  if (h.lastUsedAt !== undefined) host.lastUsedAt = time(h.lastUsedAt)
  return host
}

export function cleanIdentity(v: unknown): Identity {
  const i = obj(v, 'identity')
  return {
    id: id(i.id ?? '', 'identity id'),
    label: line(i.label ?? '', 'label', 256),
    username: line(i.username ?? '', 'username', 256),
    password: text(i.password ?? '', 'password'),
    keyId: id(i.keyId ?? '', 'key'),
    createdAt: time(i.createdAt ?? 0),
    updatedAt: time(i.updatedAt ?? 0)
  }
}

export function cleanSnippet(v: unknown): Snippet {
  const s = obj(v, 'snippet')
  return {
    id: id(s.id ?? '', 'snippet id'),
    label: line(s.label ?? '', 'label', 256),
    command: text(s.command ?? '', 'command', 64 * 1024),
    createdAt: time(s.createdAt ?? 0),
    updatedAt: time(s.updatedAt ?? 0)
  }
}

export function cleanKnownHost(v: unknown): KnownHost {
  const k = obj(v, 'known host')
  const keyType = line(k.keyType, 'key type', 64)
  const fingerprint = line(k.fingerprint, 'fingerprint', 128)
  if (!/^[a-z0-9@.-]+$/.test(keyType) || !fingerprint.startsWith('SHA256:')) fail('known host')
  return { host: line(k.host, 'known host', 300), keyType, fingerprint, addedAt: time(k.addedAt ?? 0) }
}

export function cleanKey(v: unknown): SshKey {
  const k = obj(v, 'key')
  return {
    id: id(k.id, 'key id'),
    label: line(k.label ?? '', 'label', 256),
    type: line(k.type ?? '', 'key type', 64),
    privateKey: text(k.privateKey, 'private key', 64 * 1024),
    passphrase: text(k.passphrase ?? '', 'passphrase'),
    publicKey: text(k.publicKey ?? '', 'public key', 16 * 1024),
    fingerprint: line(k.fingerprint ?? '', 'fingerprint', 128),
    encrypted: bool(k.encrypted ?? false, 'key flag'),
    createdAt: time(k.createdAt ?? 0),
    updatedAt: time(k.updatedAt ?? 0)
  }
}

export function cleanTarget(v: unknown): ConnectTarget {
  const t = obj(v, 'connection target')
  if ('hostId' in t) return { hostId: id(t.hostId, 'host id') }
  const a = obj(t.adhoc, 'connection target')
  return {
    adhoc: { address: address(a.address), port: int(a.port, 'port', 1, 65535), username: line(a.username ?? '', 'username', 256) }
  }
}

const THEMES = ['system', 'dark', 'light', 'terminal'] as const
const CURSORS = ['block', 'bar', 'underline'] as const

// partial on purpose: the renderer sends whole settings objects, unknown keys are dropped
export function cleanSettings(v: unknown): Partial<Settings> {
  const s = obj(v, 'settings')
  const out: Partial<Settings> = {}
  const set = <K extends keyof Settings>(key: K, check: (x: unknown) => Settings[K]): void => {
    if (s[key] !== undefined) out[key] = check(s[key])
  }
  set('theme', (x) => oneOf(x, 'theme', THEMES))
  set('terminalFontSize', (x) => int(x, 'font size', 6, 72))
  set('terminalFontFamily', (x) => line(x, 'font family', 512))
  set('terminalLineHeight', (x) => num(x, 'line height', 0.8, 3))
  set('cursorStyle', (x) => oneOf(x, 'cursor style', CURSORS))
  set('scrollback', (x) => int(x, 'scrollback', 0, 1_000_000))
  set('autoLockMinutes', (x) => int(x, 'auto-lock minutes', 0, 1440))
  set('keepAliveSec', (x) => int(x, 'keepalive interval', 0, 600))
  set('editorCommand', (x) => line(x, 'editor', 1024))
  set('terminalTheme', (x) => line(x, 'terminal theme', 64))
  for (const key of [
    'cursorBlink',
    'copyOnSelect',
    'rightClickPaste',
    'sftpShowHidden',
    'autoReconnect',
    'pasteProtection',
    'osc52',
    'bellNotify',
    'restoreTabs',
    'lockOnSystemLock',
    'autoUpdate'
  ] as const) {
    set(key, (x) => bool(x, key))
  }
  return out
}

const TAB_KINDS = ['ssh', 'sftp', 'docker'] as const

export function cleanLocalState(v: unknown): LocalState {
  const s = obj(v, 'session')
  return {
    tabs: list(s.tabs ?? [], 'tabs', 100, (t): SavedTab => {
      const tab = obj(t, 'tab')
      return {
        kind: oneOf(tab.kind, 'tab kind', TAB_KINDS),
        target: cleanTarget(tab.target),
        title: text(tab.title ?? '', 'tab title', 512),
        ...(tab.command !== undefined ? { command: text(tab.command, 'tab command') } : {}),
        ...(tab.label !== undefined ? { label: line(tab.label, 'tab name', 128) } : {}),
        ...(tab.color !== undefined ? { color: oneOf(tab.color, 'tab color', FOLDER_COLORS) } : {})
      }
    }),
    active: int(s.active ?? -1, 'active tab', -1, 100),
    lastPaths: record(s.lastPaths ?? {}, 'folders', 1000, (k) => line(k, 'folder key', 512), (p) => path(p))
  }
}

export function cleanEnrollment(v: unknown): PasskeyEnrollment {
  const e = obj(v, 'passkey')
  return {
    credentialId: line(e.credentialId, 'passkey id', 1024),
    salt: line(e.salt, 'passkey salt', 128),
    rpId: line(e.rpId, 'passkey site', 253),
    transports: list(e.transports ?? [], 'passkey transports', 10, (t) => line(t, 'transport', 32))
  }
}

const KEY_TYPES: readonly KeyGenType[] = ['ed25519', 'rsa-4096', 'ecdsa-256', 'ecdsa-521']

export function cleanKeyGen(v: unknown): KeyGenRequest {
  const r = obj(v, 'key request')
  return {
    type: oneOf(r.type, 'key type', KEY_TYPES),
    label: line(r.label ?? '', 'label', 256),
    comment: line(r.comment ?? '', 'comment', 256),
    passphrase: text(r.passphrase ?? '', 'passphrase')
  }
}

export function cleanKeyImport(v: unknown): KeyImportRequest {
  const r = obj(v, 'key')
  return {
    label: line(r.label ?? '', 'label', 256),
    privateKey: text(r.privateKey, 'private key', 64 * 1024),
    passphrase: text(r.passphrase ?? '', 'passphrase')
  }
}

export function cleanPromptResponse(v: unknown): PromptResponse | null {
  if (v === null) return null
  const r = obj(v, 'answer')
  return {
    values: record(r.values ?? {}, 'answer', 32, (k) => line(k, 'answer', 64), (x) => text(x, 'answer')),
    checked: bool(r.checked ?? false, 'answer'),
    ...(r.choice !== undefined ? { choice: line(r.choice, 'answer', 64) } : {})
  }
}

export const dockerAction = (v: unknown): DockerAction => oneOf(v, 'container action', ['start', 'stop', 'restart'])
export const dockerCommand = (v: unknown): DockerCommand => oneOf(v, 'container command', ['shell', 'logs'])
export const paths = (v: unknown): string[] => list(v, 'paths', 10_000, (p) => path(p))
