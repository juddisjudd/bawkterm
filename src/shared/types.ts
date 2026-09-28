export interface Host {
  id: string
  label: string
  address: string
  port: number
  group: string
  username: string
  password: string
  keyId: string
  identityId: string
  useAgent: boolean
  jumpHostId: string
  tags: string[]
  notes: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface SshKey {
  id: string
  label: string
  type: string
  privateKey: string
  passphrase: string
  publicKey: string
  fingerprint: string
  encrypted: boolean
  createdAt: number
  updatedAt: number
}

export interface Identity {
  id: string
  label: string
  username: string
  password: string
  keyId: string
  createdAt: number
  updatedAt: number
}

export interface KnownHost {
  host: string
  keyType: string
  fingerprint: string
  addedAt: number
}

export interface Snippet {
  id: string
  label: string
  command: string
  createdAt: number
  updatedAt: number
}

export interface SyncConfig {
  url: string
  token: string
  key: string
}

export interface SyncState {
  config: SyncConfig | null
  lastSeq: number
  synced: Record<string, number>
  lastSyncAt?: number
  lastError?: string
}

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  lastSyncAt?: number
  error?: string
}

export type ThemeSetting = 'system' | 'dark' | 'light'
export type CursorStyle = 'block' | 'bar' | 'underline'

export interface Settings {
  theme: ThemeSetting
  terminalFontSize: number
  terminalFontFamily: string
  terminalLineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  copyOnSelect: boolean
  rightClickPaste: boolean
  autoLockMinutes: number
  sftpShowHidden: boolean
  keepAliveSec: number
}

export interface VaultData {
  version: 1
  hosts: Host[]
  keys: SshKey[]
  identities: Identity[]
  knownHosts: KnownHost[]
  snippets: Snippet[]
  settings: Settings
  sync: SyncState
}

export type VaultState = 'none' | 'locked' | 'unlocked'

export interface VaultStatus {
  state: VaultState
  remembered: boolean
  canRemember: boolean
}

export type KeyGenType = 'ed25519' | 'rsa-4096' | 'ecdsa-256' | 'ecdsa-521'

export interface KeyGenRequest {
  type: KeyGenType
  label: string
  comment: string
  passphrase: string
}

export interface KeyImportRequest {
  label: string
  privateKey: string
  passphrase: string
}

export interface AdhocTarget {
  address: string
  port: number
  username: string
}

export type ConnectTarget = { hostId: string } | { adhoc: AdhocTarget }

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionEvent {
  sessionId: string
  status: SessionStatus
  message?: string
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'dir' | 'link'
  linkDir: boolean
  size: number
  mtime: number
  mode: number
}

export type TransferDirection = 'upload' | 'download'
export type TransferState = 'queued' | 'active' | 'done' | 'error' | 'cancelled'

export interface TransferInfo {
  id: string
  sessionId: string
  direction: TransferDirection
  name: string
  source: string
  dest: string
  bytes: number
  total: number
  files: number
  filesDone: number
  state: TransferState
  error?: string
  startedAt: number
}

export interface PromptField {
  name: string
  label: string
  secret?: boolean
  value?: string
}

export type PromptKind = 'hostkey-new' | 'hostkey-changed' | 'credentials' | 'kbd-interactive' | 'passphrase'

export interface PromptRequest {
  id: string
  sessionId: string
  kind: PromptKind
  title: string
  message: string
  detail?: string
  fields: PromptField[]
  confirmLabel: string
  danger?: boolean
  checkbox?: { name: string; label: string }
}

export interface PromptResponse {
  values: Record<string, string>
  checked: boolean
}

export interface ImportSummary {
  hosts: number
  keys: number
  skipped: string[]
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }
