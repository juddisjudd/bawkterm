import type {
  ConnectTarget,
  FileEntry,
  Host,
  Identity,
  ImportSummary,
  KeyGenRequest,
  KeyImportRequest,
  PromptRequest,
  PromptResponse,
  SessionEvent,
  Settings,
  Snippet,
  SshKey,
  SyncStatus,
  TransferInfo,
  VaultData,
  VaultStatus
} from './types'

type Unsubscribe = () => void

export interface BawkApi {
  platform: string
  vault: {
    status(): Promise<VaultStatus>
    get(): Promise<VaultData | null>
    create(password: string, remember: boolean): Promise<VaultData>
    unlock(password: string, remember: boolean): Promise<VaultData>
    lock(): Promise<void>
    setRemember(on: boolean): Promise<VaultStatus>
    changePassword(current: string, next: string): Promise<void>
    onChanged(cb: (data: VaultData | null) => void): Unsubscribe
  }
  hosts: {
    save(host: Host): Promise<Host>
    remove(id: string): Promise<void>
  }
  keys: {
    import(req: KeyImportRequest): Promise<SshKey>
    generate(req: KeyGenRequest): Promise<SshKey>
    rename(id: string, label: string): Promise<void>
    remove(id: string): Promise<void>
    readFile(): Promise<{ name: string; content: string } | null>
  }
  identities: {
    save(identity: Identity): Promise<Identity>
    remove(id: string): Promise<void>
  }
  snippets: {
    save(snippet: Snippet): Promise<Snippet>
    remove(id: string): Promise<void>
  }
  sync: {
    status(): Promise<SyncStatus>
    create(url: string, token: string): Promise<void>
    join(link: string): Promise<void>
    link(): Promise<string>
    now(): Promise<void>
    disconnect(): Promise<void>
    onStatus(cb: (status: SyncStatus) => void): Unsubscribe
  }
  knownHosts: {
    remove(host: string, keyType: string): Promise<void>
  }
  settings: {
    save(settings: Settings): Promise<void>
  }
  importSshConfig(): Promise<ImportSummary>
  ssh: {
    open(sessionId: string, target: ConnectTarget, cols: number, rows: number): Promise<void>
    write(sessionId: string, data: string): void
    resize(sessionId: string, cols: number, rows: number): void
    ack(sessionId: string, bytes: number): void
    close(sessionId: string): Promise<void>
    onData(cb: (sessionId: string, data: Uint8Array) => void): Unsubscribe
    onStatus(cb: (event: SessionEvent) => void): Unsubscribe
  }
  sftp: {
    open(sessionId: string, target: ConnectTarget): Promise<{ home: string; title: string }>
    list(sessionId: string, path: string): Promise<FileEntry[]>
    realpath(sessionId: string, path: string): Promise<string>
    mkdir(sessionId: string, path: string): Promise<void>
    rename(sessionId: string, from: string, to: string): Promise<void>
    chmod(sessionId: string, path: string, mode: number): Promise<void>
    remove(sessionId: string, paths: string[]): Promise<void>
    upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<void>
    download(sessionId: string, remotePaths: string[], localDir: string): Promise<void>
    cancel(transferId: string): Promise<void>
    close(sessionId: string): Promise<void>
    onStatus(cb: (event: SessionEvent) => void): Unsubscribe
    onTransfer(cb: (info: TransferInfo) => void): Unsubscribe
  }
  local: {
    home(): Promise<string>
    list(path: string): Promise<FileEntry[]>
    mkdir(path: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    trash(paths: string[]): Promise<void>
    open(path: string): Promise<void>
  }
  prompts: {
    onRequest(cb: (req: PromptRequest) => void): Unsubscribe
    onCancel(cb: (id: string) => void): Unsubscribe
    respond(id: string, res: PromptResponse | null): void
  }
  app: {
    setTitleBar(background: string, foreground: string): void
    openExternal(url: string): void
    pathForFile(file: File): string
  }
}
