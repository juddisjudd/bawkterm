import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  EditInfo,
  ConnectTarget,
  PromptChoice,
  PromptField,
  PromptRequest,
  PromptResponse,
  SessionEvent,
  SessionStatus,
  Settings,
  SyncStatus,
  TransferInfo,
  VaultData,
  VaultStatus,
  LocalState
} from '@shared/types'

export type Section = 'hosts' | 'keychain' | 'snippets' | 'known' | 'settings'
export type TabKind = 'ssh' | 'sftp' | 'docker'

export interface Tab {
  id: string
  kind: TabKind
  target: ConnectTarget
  title: string
  status: SessionStatus
  message?: string
  command?: string
  dropped?: boolean
  activity?: boolean
  bell?: boolean
}

export interface Modal {
  id: string
  title: string
  message?: string
  detail?: string
  fields: PromptField[]
  confirmLabel: string
  danger?: boolean
  checkbox?: { name: string; label: string }
  choices?: PromptChoice[]
  resolve: (res: PromptResponse | null) => void
}

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
}

export type MenuItem = { label: string; action: () => void; danger?: boolean; disabled?: boolean } | 'sep'

export interface Menu {
  x: number
  y: number
  items: MenuItem[]
}

const api = window.api

class AppState {
  status = $state<VaultStatus | null>(null)
  vault = $state.raw<VaultData | null>(null)
  settings = $state.raw<Settings>({ ...DEFAULT_SETTINGS })
  everUnlocked = $state(false)
  tabs = $state<Tab[]>([])
  #active = $state('home')
  section = $state<Section>('hosts')
  modals = $state<Modal[]>([])
  toasts = $state<Toast[]>([])
  menu = $state<Menu | null>(null)
  paletteOpen = $state(false)
  paletteMode = $state<'all' | 'snippets'>('all')
  editingHost = $state<string | null>(null)
  transfers = $state<TransferInfo[]>([])
  edits = $state<EditInfo[]>([])
  syncStatus = $state<SyncStatus>({ phase: 'off' })
  systemDark = $state(window.matchMedia('(prefers-color-scheme: dark)').matches)

  theme = $derived<'dark' | 'light'>(
    this.settings.theme === 'system' ? (this.systemDark ? 'dark' : 'light') : this.settings.theme
  )

  private toastSeq = 0
  private restored = false
  private pendingLocal: LocalState | null = null
  private localTimer: ReturnType<typeof setTimeout> | undefined

  get active(): string {
    return this.#active
  }

  set active(id: string) {
    this.#active = id
    this.persistTabs()
  }

  updateLocal(change: (local: LocalState) => void): void {
    if (!this.vault) return
    const next = structuredClone(this.pendingLocal ?? this.vault.local)
    change(next)
    this.pendingLocal = next
    clearTimeout(this.localTimer)
    this.localTimer = setTimeout(() => {
      const local = this.pendingLocal
      this.pendingLocal = null
      if (local) void api.session.save(local).catch(() => {})
    }, 800)
  }

  rememberPath(key: string, path: string): void {
    if (path && this.vault?.local.lastPaths[key] !== path) this.updateLocal((l) => (l.lastPaths[key] = path))
  }

  private persistTabs(): void {
    if (!this.vault?.settings.restoreTabs) return
    this.updateLocal((l) => {
      l.tabs = this.tabs.map((t) => ({ kind: t.kind, target: $state.snapshot(t.target), title: t.title, command: t.command }))
      l.active = this.tabs.findIndex((t) => t.id === this.#active)
    })
  }

  private restoreTabs(data: VaultData): void {
    const saved = data.local.tabs.filter((t) => !('hostId' in t.target) || data.hosts.some((h) => 'hostId' in t.target && h.id === t.target.hostId))
    if (!saved.length || this.tabs.length) return
    for (const t of saved) {
      this.tabs.push({ id: crypto.randomUUID(), kind: t.kind, target: t.target, title: t.title, command: t.command, status: 'connecting' })
    }
    const i = data.local.active
    this.#active = i >= 0 && i < this.tabs.length ? this.tabs[i].id : 'home'
  }

  constructor() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => (this.systemDark = e.matches))
    api.vault.onChanged((data) => this.setVault(data))
    api.ssh.onStatus((e) => this.updateTab(e))
    api.sftp.onStatus((e) => this.updateTab(e))
    api.docker.onStatus((e) => this.updateTab(e))
    api.sftp.onTransfer((info) => this.updateTransfer(info))
    api.sftp.onEdit((info) => this.updateEdit(info))
    api.prompts.onRequest((req) => this.showPrompt(req))
    api.prompts.onCancel((id) => this.dropModal(id))
    api.sync.onStatus((s) => (this.syncStatus = s))
  }

  async init(): Promise<void> {
    this.status = await api.vault.status()
    if (this.status.state === 'unlocked') {
      const data = await api.vault.get()
      if (data) this.setVault(data)
      this.syncStatus = await api.sync.status()
    }
  }

  setVault(data: VaultData | null): void {
    this.vault = data
    if (data) {
      this.settings = data.settings
      this.everUnlocked = true
      if (!this.restored) {
        this.restored = true
        if (data.settings.restoreTabs) this.restoreTabs(data)
      }
      if (this.status?.state !== 'unlocked') {
        void this.refreshStatus()
        void api.sync.status().then((s) => (this.syncStatus = s))
      }
    } else {
      this.modals = []
      this.menu = null
      this.paletteOpen = false
      void this.refreshStatus()
    }
  }

  async refreshStatus(): Promise<void> {
    this.status = await api.vault.status()
  }

  async lock(): Promise<void> {
    await api.vault.lock()
  }

  openTab(kind: TabKind, target: ConnectTarget, title: string, command?: string): void {
    const tab: Tab = { id: crypto.randomUUID(), kind, target, title, status: 'connecting', command }
    this.tabs.push(tab)
    this.active = tab.id
  }

  openHost(kind: TabKind, hostId: string): void {
    const host = this.vault?.hosts.find((h) => h.id === hostId)
    if (!host) return
    if (host.kind === 'rdp') void this.launchRdp(hostId)
    else this.openTab(kind, { hostId }, host.label || host.address)
  }

  async launchRdp(hostId: string): Promise<void> {
    const host = this.vault?.hosts.find((h) => h.id === hostId)
    this.toast(`Opening Remote Desktop for ${host?.label || host?.address}`)
    await api.rdp.launch(hostId).catch((err) => this.fail(err))
  }

  closeTab(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    const [tab] = this.tabs.splice(i, 1)
    if (tab.kind === 'ssh') void api.ssh.close(id)
    else if (tab.kind === 'sftp') void api.sftp.close(id)
    else void api.docker.close(id)
    this.transfers = this.transfers.filter((t) => t.sessionId !== id)
    if (this.active === id) this.active = this.tabs[Math.min(i, this.tabs.length - 1)]?.id ?? 'home'
    else this.persistTabs()
  }

  closeOtherTabs(keep: string): void {
    for (const tab of [...this.tabs]) if (tab.id !== keep) this.closeTab(tab.id)
    this.active = keep
  }

  cycleTab(step: number): void {
    const ids = ['home', ...this.tabs.map((t) => t.id)]
    const i = ids.indexOf(this.active)
    this.active = ids[(i + step + ids.length) % ids.length]
  }

  updateTab(e: SessionEvent): void {
    const tab = this.tabs.find((t) => t.id === e.sessionId)
    if (!tab) return
    tab.status = e.status
    tab.message = e.message
    tab.dropped = e.dropped
  }

  mark(id: string, kind: 'activity' | 'bell'): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab && !tab[kind]) tab[kind] = true
  }

  clearMarks(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab && (tab.activity || tab.bell)) {
      tab.activity = false
      tab.bell = false
    }
  }

  updateEdit(info: EditInfo): void {
    const rest = this.edits.filter((e) => !(e.sessionId === info.sessionId && e.remotePath === info.remotePath))
    this.edits = info.state === 'closed' ? rest : [...rest, info]
  }

  updateTransfer(info: TransferInfo): void {
    const i = this.transfers.findIndex((t) => t.id === info.id)
    if (i >= 0) this.transfers[i] = info
    else this.transfers.unshift(info)
  }

  clearTransfers(sessionId: string): void {
    this.transfers = this.transfers.filter(
      (t) => t.sessionId !== sessionId || t.state === 'active' || t.state === 'queued'
    )
  }

  toast(message: string, kind: Toast['kind'] = 'info'): void {
    const id = ++this.toastSeq
    this.toasts.push({ id, kind, message })
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3000)
  }

  fail(err: unknown): void {
    this.toast(err instanceof Error ? err.message : String(err), 'error')
  }

  private showPrompt(req: PromptRequest): void {
    this.modals.push({
      id: req.id,
      title: req.title,
      message: req.message,
      detail: req.detail,
      fields: req.fields,
      confirmLabel: req.confirmLabel,
      danger: req.danger,
      checkbox: req.checkbox,
      choices: req.choices,
      resolve: (res) => api.prompts.respond(req.id, res)
    })
  }

  dropModal(id: string): void {
    this.modals = this.modals.filter((m) => m.id !== id)
  }

  ask(opts: Omit<Modal, 'id' | 'resolve'>): Promise<PromptResponse | null> {
    return new Promise((resolve) => this.modals.push({ ...opts, id: crypto.randomUUID(), resolve }))
  }

  async confirm(title: string, message: string, confirmLabel = 'Delete', danger = true): Promise<boolean> {
    return (await this.ask({ title, message, fields: [], confirmLabel, danger })) !== null
  }

  async askText(title: string, label: string, value = '', confirmLabel = 'Save'): Promise<string | null> {
    const res = await this.ask({ title, fields: [{ name: 'value', label, value }], confirmLabel })
    const text = res?.values.value.trim()
    return text ? text : null
  }

  openPalette(mode: 'all' | 'snippets' = 'all'): void {
    this.paletteMode = mode
    this.paletteOpen = true
  }

  openMenu(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault()
    this.menu = { x: event.clientX, y: event.clientY, items }
  }
}

export const app = new AppState()
