import type {
  EditorChoice,
  SaveResult,
  TextFile,
  ContainerInfo,
  ContainerStats,
  EditInfo,
  DockerAction,
  DockerCommand,
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
  VaultStatus,
  LocalState,
  PasskeyEnrollment,
  UnlockStatus,
  UpdateStatus
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
    setRemember(on: boolean, password?: string): Promise<VaultStatus>
    verifyPassword(password: string): Promise<void>
    changePassword(current: string, next: string): Promise<void>
    onChanged(cb: (data: VaultData | null) => void): Unsubscribe
  }
  unlock: {
    status(): Promise<UnlockStatus>
    hello(): Promise<VaultData>
    enableHello(password: string): Promise<void>
    disableHello(): Promise<void>
    passkey(prfOutput: string): Promise<VaultData>
    enablePasskey(enrollment: PasskeyEnrollment, prfOutput: string, password: string): Promise<void>
    disablePasskey(): Promise<void>
  }
  secrets: {
    reveal(kind: 'host' | 'identity', id: string, password: string): Promise<string>
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
    check(url: string, token: string): Promise<number>
    // erase: remove what the server holds for this token first
    create(url: string, token: string, erase?: boolean): Promise<void>
    join(link: string): Promise<void>
    copyLink(password: string): Promise<void>
    now(): Promise<void>
    disconnect(): Promise<void>
    onStatus(cb: (status: SyncStatus) => void): Unsubscribe
  }
  session: {
    save(state: LocalState): Promise<void>
  }
  knownHosts: {
    remove(host: string, keyType: string): Promise<void>
  }
  settings: {
    save(settings: Settings): Promise<void>
  }
  importSshConfig(): Promise<ImportSummary>
  ssh: {
    open(sessionId: string, target: ConnectTarget, cols: number, rows: number, command?: string): Promise<void>
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
    readText(sessionId: string, path: string): Promise<TextFile>
    writeText(
      sessionId: string,
      path: string,
      text: string,
      bom: boolean,
      expected: { mtime: number; size: number } | null
    ): Promise<SaveResult>
    edit(sessionId: string, remotePath: string): Promise<void>
    editStop(sessionId: string, remotePath: string): Promise<void>
    onEdit(cb: (info: EditInfo) => void): Unsubscribe
  }
  rdp: {
    launch(hostId: string): Promise<void>
  }
  docker: {
    open(sessionId: string, target: ConnectTarget): Promise<{ title: string; version: string }>
    list(sessionId: string): Promise<ContainerInfo[]>
    stats(sessionId: string): Promise<ContainerStats[]>
    action(sessionId: string, containerId: string, action: DockerAction): Promise<void>
    command(sessionId: string, containerId: string, kind: DockerCommand): Promise<string>
    close(sessionId: string): Promise<void>
    onStatus(cb: (event: SessionEvent) => void): Unsubscribe
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
  win: {
    focus(): void
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximized(cb: (maximized: boolean) => void): Unsubscribe
  }
  update: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    install(): Promise<void>
    onStatus(cb: (status: UpdateStatus) => void): Unsubscribe
  }
  app: {
    openExternal(url: string): void
    copy(text: string): void
    pathForFile(file: File): string
    editors(): Promise<EditorChoice[]>
    pickEditor(): Promise<string | null>
  }
}
