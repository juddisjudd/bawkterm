export type HostKind = 'ssh' | 'rdp'

export interface TextFile {
  text: string
  bom: boolean
  mtime: number
  size: number
}

export type SaveResult = { conflict: true } | { conflict: false; mtime: number; size: number }

export interface EditorChoice {
  name: string
  command: string
}

export type FolderColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

export interface Host {
  id: string
  kind: HostKind
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
  rdpFullscreen: boolean
  startupCommand: string
  bookmarks: string[]
  folderColors: Record<string, FolderColor>
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
  // deletion times, so a replayed old copy of a deleted item is not brought back
  tombstones: Record<string, number>
  lastSyncAt?: number
  lastError?: string
}

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error'

export interface UpdateStatus {
  // false in dev builds and where a package manager owns updates (Flatpak, AUR, tar.gz)
  supported: boolean
  managedBy?: 'dev' | 'flatpak' | 'package'
  state: UpdateState
  version?: string
  percent?: number
  error?: string
}

export type SyncPhase = 'off' | 'idle' | 'syncing' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  lastSyncAt?: number
  error?: string
}

export type ThemeSetting = 'system' | 'dark' | 'light' | 'terminal'
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
  editorCommand: string
  autoReconnect: boolean
  pasteProtection: boolean
  osc52: boolean
  bellNotify: boolean
  terminalTheme: string
  restoreTabs: boolean
  lockOnSystemLock: boolean
  autoUpdate: boolean
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
  local: LocalState
}

export interface SavedTab {
  kind: 'ssh' | 'sftp' | 'docker'
  target: ConnectTarget
  title: string
  command?: string
}

// per device, never synced
export interface LocalState {
  tabs: SavedTab[]
  active: number
  lastPaths: Record<string, string>
}

export interface PasskeyEnrollment {
  credentialId: string
  salt: string
  rpId: string
  transports: string[]
}

export interface UnlockStatus {
  hello: { supported: boolean; enabled: boolean }
  passkey: ({ enabled: true } & PasskeyEnrollment) | { enabled: false }
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

export interface ContainerInfo {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  project: string
  service: string
}

export interface ContainerStats {
  id: string
  cpu: string
  mem: string
}

export type DockerAction = 'start' | 'stop' | 'restart'
export type DockerCommand = 'shell' | 'logs'

export type EditState = 'open' | 'uploading' | 'uploaded' | 'error' | 'closed'

export interface EditInfo {
  sessionId: string
  remotePath: string
  name: string
  state: EditState
  message?: string
  at: number
}

export interface SessionEvent {
  sessionId: string
  status: SessionStatus
  message?: string
  dropped?: boolean
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
export type TransferState = 'queued' | 'active' | 'done' | 'error' | 'cancelled' | 'skipped'

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

export type PromptKind = 'hostkey-new' | 'hostkey-changed' | 'credentials' | 'kbd-interactive' | 'passphrase' | 'confirm'

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
  choices?: PromptChoice[]
}

export interface PromptChoice {
  id: string
  label: string
  danger?: boolean
}

export interface PromptResponse {
  values: Record<string, string>
  checked: boolean
  choice?: string
}

export interface ImportSummary {
  hosts: number
  keys: number
  skipped: string[]
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }
