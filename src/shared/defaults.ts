import type { Host, Identity, LocalState, Settings, Snippet, SyncState, VaultData } from './types'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  terminalFontSize: 14,
  terminalFontFamily: '"IBM Plex Mono", Consolas, monospace',
  terminalLineHeight: 1.2,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  copyOnSelect: false,
  rightClickPaste: true,
  autoLockMinutes: 0,
  sftpShowHidden: false,
  keepAliveSec: 30,
  editorCommand: '',
  autoReconnect: true,
  pasteProtection: true,
  osc52: true,
  bellNotify: true,
  terminalTheme: 'auto',
  restoreTabs: true
}

export function emptyVault(): VaultData {
  return {
    version: 1,
    hosts: [],
    keys: [],
    identities: [],
    knownHosts: [],
    snippets: [],
    settings: { ...DEFAULT_SETTINGS },
    sync: emptySync(),
    local: emptyLocal()
  }
}

export function blankHost(): Host {
  const now = Date.now()
  return {
    id: '',
    kind: 'ssh',
    label: '',
    address: '',
    port: 22,
    group: '',
    username: '',
    password: '',
    keyId: '',
    identityId: '',
    useAgent: false,
    jumpHostId: '',
    tags: [],
    notes: '',
    rdpFullscreen: true,
    startupCommand: '',
    bookmarks: [],
    createdAt: now,
    updatedAt: now
  }
}

export function emptyLocal(): LocalState {
  return { tabs: [], active: -1, lastPaths: {} }
}

export function emptySync(): SyncState {
  return { config: null, lastSeq: 0, synced: {} }
}

export function blankIdentity(): Identity {
  const now = Date.now()
  return { id: '', label: '', username: '', password: '', keyId: '', createdAt: now, updatedAt: now }
}

export function blankSnippet(): Snippet {
  const now = Date.now()
  return { id: '', label: '', command: '', createdAt: now, updatedAt: now }
}

export function hostKeyId(address: string, port: number): string {
  return port === 22 ? address : `[${address}]:${port}`
}
