import { DEFAULT_SETTINGS } from '@shared/defaults'
import { appColors, findTerminalTheme, setImportedThemes } from './theme'
import { insert, layout, leaves, mapPanes, neighbor, sibling, type Direction, type PaneDir, type PaneTree } from './panes'
import type {
  EditInfo,
  ConnectTarget,
  FolderColor,
  PromptChoice,
  PromptField,
  PromptRequest,
  PromptResponse,
  SavedTab,
  SessionEvent,
  SessionStatus,
  Settings,
  SyncStatus,
  TransferInfo,
  VaultData,
  VaultStatus,
  LocalState,
  UnlockStatus,
  UpdateStatus
} from '@shared/types'

export type Section = 'hosts' | 'keychain' | 'snippets' | 'known' | 'settings'
export type SettingsTab = 'appearance' | 'terminal' | 'connections' | 'files' | 'sync' | 'security' | 'updates' | 'shortcuts'
export type TabKind = 'ssh' | 'sftp' | 'docker' | 'edit'

export interface Tab {
  id: string
  kind: TabKind
  target: ConnectTarget
  title: string
  status: SessionStatus
  message?: string
  command?: string
  dropped?: boolean
  bell?: boolean
  edit?: { sessionId: string; path: string }
  dirty?: boolean
  label?: string
  color?: FolderColor
}

export const tabName = (tab: Tab): string => tab.label || tab.title

export interface Split {
  id: string
  root: PaneTree<string>
  focus: string
  broadcast: boolean
}

export interface Placement {
  beside: string
  dir: PaneDir
}

export interface StripEntry {
  key: string
  tab: Tab
  panes: Tab[]
  split?: Split
}

// keeps the saved tree within the depth that validation accepts
const MAX_PANES = 16

export interface Modal {
  id: string
  title: string
  message?: string
  detail?: string
  fields: PromptField[]
  confirmLabel: string
  cancelLabel?: string
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

export type MenuItem =
  | { label: string; action: () => void; danger?: boolean; disabled?: boolean }
  | { swatches: FolderColor[]; current: FolderColor | null; pick: (color: FolderColor | null) => void }
  | 'sep'

export interface Menu {
  x: number
  y: number
  items: MenuItem[]
}

const api = window.api

class AppState {
  status = $state<VaultStatus | null>(null)
  private quitting = false
  vault = $state.raw<VaultData | null>(null)
  settings = $state.raw<Settings>({ ...DEFAULT_SETTINGS })
  everUnlocked = $state(false)
  tabs = $state<Tab[]>([])
  splits = $state<Split[]>([])
  #active = $state('home')
  #splitOf = $derived(new Map(this.splits.flatMap((s) => leaves(s.root).map((id) => [id, s] as const))))
  strip = $derived.by((): StripEntry[] => {
    const entries: StripEntry[] = []
    const seen = new Set<string>()
    for (const tab of this.tabs) {
      const split = this.splitOf(tab.id)
      if (!split) entries.push({ key: tab.id, tab, panes: [tab] })
      else if (!seen.has(split.id)) {
        seen.add(split.id)
        const panes = leaves(split.root).flatMap((id) => this.tabs.find((t) => t.id === id) ?? [])
        entries.push({ key: split.id, tab: panes.find((t) => t.id === split.focus) ?? panes[0], panes, split })
      }
    }
    return entries
  })
  section = $state<Section>('hosts')
  settingsTab = $state<SettingsTab>('appearance')
  modals = $state<Modal[]>([])
  toasts = $state<Toast[]>([])
  menu = $state<Menu | null>(null)
  paletteOpen = $state(false)
  paletteMode = $state<'all' | 'snippets'>('all')
  palettePlace = $state<Placement | null>(null)
  editingHost = $state<string | null>(null)
  transfers = $state<TransferInfo[]>([])
  edits = $state<EditInfo[]>([])
  syncStatus = $state<SyncStatus>({ phase: 'off' })
  updateStatus = $state<UpdateStatus>({ supported: false, state: 'idle' })
  unlockStatus = $state<UnlockStatus | null>(null)
  systemDark = $state(window.matchMedia('(prefers-color-scheme: dark)').matches)

  theme = $derived.by<'dark' | 'light'>(() => {
    const setting = this.settings.theme
    if (setting === 'dark' || setting === 'light') return setting
    const terminal = setting === 'terminal' ? findTerminalTheme(this.settings.terminalTheme) : undefined
    if (terminal && terminal.id !== 'auto') return terminal.dark ? 'dark' : 'light'
    return this.systemDark ? 'dark' : 'light'
  })
  appColors = $derived(this.settings.theme === 'terminal' ? appColors(this.settings.terminalTheme) : null)

  private toastSeq = 0
  private restored = false
  private pendingLocal: LocalState | null = null
  private localTimer: ReturnType<typeof setTimeout> | undefined

  get active(): string {
    return this.#active
  }

  set active(id: string) {
    this.#active = id
    const split = this.splitOf(id)
    if (split && split.focus !== id) split.focus = id
    this.persistTabs()
  }

  splitOf(id: string): Split | undefined {
    return this.#splitOf.get(id)
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

  lastPath(key: string): string | undefined {
    return (this.pendingLocal ?? this.vault?.local)?.lastPaths[key]
  }

  rememberPath(key: string, path: string): void {
    if (path && this.vault?.local.lastPaths[key] !== path) this.updateLocal((l) => (l.lastPaths[key] = path))
  }

  persistTabs(): void {
    if (!this.vault?.settings.restoreTabs) return
    this.updateLocal((l) => {
      const kept = this.tabs.filter((t) => t.kind !== 'edit')
      const index = new Map(kept.map((t, i) => [t.id, i]))
      l.splits = this.splits
        .map((s) => mapPanes(s.root, (id) => index.get(id)))
        .filter((root): root is PaneTree<number> => !!root && !('tab' in root))
      l.tabs = kept.map((t) => ({
        kind: t.kind as SavedTab['kind'],
        target: $state.snapshot(t.target),
        title: t.title,
        command: t.command,
        ...(t.label ? { label: t.label } : {}),
        ...(t.color ? { color: t.color } : {})
      }))
      l.active = kept.findIndex((t) => t.id === this.#active)
    })
  }

  private restoreTabs(data: VaultData): void {
    if (this.tabs.length) return
    const ids = data.local.tabs.map((t) =>
      !('hostId' in t.target) || data.hosts.some((h) => 'hostId' in t.target && h.id === t.target.hostId)
        ? crypto.randomUUID()
        : undefined
    )
    data.local.tabs.forEach((t, i) => {
      const id = ids[i]
      if (!id) return
      this.tabs.push({
        id,
        kind: t.kind,
        target: t.target,
        title: t.title,
        command: t.command,
        label: t.label,
        color: t.color,
        status: 'connecting'
      })
    })
    if (!this.tabs.length) return
    const placed = new Set<string>()
    for (const saved of data.local.splits) {
      const root = mapPanes(saved, (i) => {
        const id = ids[i]
        if (!id || placed.has(id)) return null
        placed.add(id)
        return id
      })
      if (root && !('tab' in root)) this.splits.push({ id: crypto.randomUUID(), root, focus: leaves(root)[0], broadcast: false })
    }
    this.#active = ids[data.local.active] ?? 'home'
    const split = this.splitOf(this.#active)
    if (split) split.focus = this.#active
  }

  constructor() {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => (this.systemDark = e.matches))
    window.addEventListener('beforeunload', (e) => {
      if (this.quitting || !this.tabs.some((t) => t.dirty)) return
      e.preventDefault()
      e.returnValue = false
      void this.confirm('Unsaved changes', 'Some files have changes that are not saved.', 'Quit without saving').then((ok) => {
        if (!ok) return
        this.quitting = true
        api.win.close()
      })
    })
    api.vault.onChanged((data) => this.setVault(data))
    api.ssh.onStatus((e) => this.updateTab(e))
    api.sftp.onStatus((e) => this.updateTab(e))
    api.docker.onStatus((e) => this.updateTab(e))
    api.sftp.onTransfer((info) => this.updateTransfer(info))
    api.sftp.onEdit((info) => this.updateEdit(info))
    api.prompts.onRequest((req) => this.showPrompt(req))
    api.prompts.onCancel((id) => this.dropModal(id))
    api.sync.onStatus((s) => (this.syncStatus = s))
    api.update.onStatus((s) => this.setUpdate(s))
  }

  async init(): Promise<void> {
    void api.update.status().then((s) => (this.updateStatus = s))
    this.status = await api.vault.status()
    void this.refreshUnlock()
    if (this.status.state === 'unlocked') {
      const data = await api.vault.get()
      if (data) this.setVault(data)
      this.syncStatus = await api.sync.status()
    }
  }

  setVault(data: VaultData | null): void {
    this.vault = data
    if (data) {
      setImportedThemes(data.settings.customThemes)
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

  private setUpdate(status: UpdateStatus): void {
    if (status.state === 'ready' && this.updateStatus.state !== 'ready') {
      this.toast(`bawkterm ${status.version} is ready. Restart from the sidebar to update.`)
    }
    this.updateStatus = status
  }

  async restartToUpdate(): Promise<void> {
    if (
      this.tabs.some((t) => t.dirty) &&
      !(await this.confirm('Unsaved changes', 'Some files have changes that are not saved.', 'Restart without saving'))
    ) {
      return
    }
    this.quitting = true
    await api.update.install().catch((err) => {
      this.quitting = false
      this.fail(err)
    })
  }

  async refreshUnlock(): Promise<void> {
    this.unlockStatus = await api.unlock.status().catch(() => null)
  }

  async refreshStatus(): Promise<void> {
    this.status = await api.vault.status()
  }

  async lock(): Promise<void> {
    await api.vault.lock()
  }

  openTab(
    kind: TabKind,
    target: ConnectTarget,
    title: string,
    command?: string,
    look: Pick<Tab, 'label' | 'color'> = {},
    place: Placement | null = null
  ): void {
    const tab: Tab = { id: crypto.randomUUID(), kind, target, title, status: 'connecting', command, ...look }
    if (!place || !this.addPane(tab, place)) this.tabs.push(tab)
    this.active = tab.id
  }

  private addPane(tab: Tab, { beside, dir }: Placement): boolean {
    if (!this.tabs.some((t) => t.id === beside)) return false
    const split = this.splitOf(beside)
    const members = new Set(split ? leaves(split.root) : [beside])
    if (members.size >= MAX_PANES) {
      this.toast(`A tab holds up to ${MAX_PANES} panes, so this opened in a new tab`)
      return false
    }
    this.tabs.splice(this.tabs.findLastIndex((t) => members.has(t.id)) + 1, 0, tab)
    if (split) split.root = insert($state.snapshot(split.root), beside, tab.id, dir)
    else this.splits.push({ id: crypto.randomUUID(), root: insert({ tab: beside }, beside, tab.id, dir), focus: tab.id, broadcast: false })
    return true
  }

  targetTitle(target: ConnectTarget, fallback: string): string {
    const host = 'hostId' in target ? this.vault?.hosts.find((h) => h.id === target.hostId) : undefined
    return host?.label || host?.address || fallback
  }

  splitTab(id: string, dir: PaneDir): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || tab.kind === 'edit') return
    const target = $state.snapshot(tab.target)
    this.openTab(tab.kind, target, this.targetTitle(target, tab.title), undefined, {}, { beside: id, dir })
  }

  detachPane(id: string): void {
    const split = this.splitOf(id)
    if (!split) return
    this.dropPane(split, id)
    this.active = id
  }

  private dropPane(split: Split, id: string): void {
    const root = mapPanes($state.snapshot(split.root), (t) => (t === id ? null : t))
    if (!root || 'tab' in root) {
      this.splits = this.splits.filter((s) => s.id !== split.id)
      return
    }
    split.root = root
    if (split.focus === id) split.focus = leaves(root)[0]
  }

  paneIds(id: string): string[] {
    const split = this.splitOf(id)
    return split ? leaves(split.root) : [id]
  }

  focusPane(toward: Direction): boolean {
    const split = this.splitOf(this.active)
    if (!split) return false
    const next = neighbor(layout(split.root).panes, this.active, toward)
    if (next) this.active = next
    return true
  }

  toggleBroadcast(split: Split): void {
    split.broadcast = !split.broadcast
    if (split.broadcast) this.toast('Typing in one terminal of this tab now goes to all of them')
  }

  broadcastPeers(id: string): string[] {
    const split = this.splitOf(id)
    if (!split?.broadcast) return []
    return leaves(split.root).filter(
      (other) => other !== id && this.tabs.some((t) => t.id === other && t.kind === 'ssh' && t.status === 'connected')
    )
  }

  async renameTab(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    const res = await this.ask({
      title: 'Rename tab',
      message: `Leave it empty to go back to "${tab.title}".`,
      fields: [{ name: 'label', label: 'name', value: tabName(tab) }],
      confirmLabel: 'Rename'
    })
    if (!res) return
    const label = res.values.label.trim().slice(0, 64)
    tab.label = label && label !== tab.title ? label : undefined
    this.persistTabs()
  }

  colorTab(id: string, color: FolderColor | null): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    tab.color = color ?? undefined
    this.persistTabs()
  }

  openEditor(from: Tab, path: string): void {
    const target = JSON.stringify(from.target)
    const open = this.tabs.find((t) => t.kind === 'edit' && t.edit?.path === path && JSON.stringify(t.target) === target)
    if (open) {
      this.active = open.id
      return
    }
    const title = path.split('/').filter(Boolean).pop() ?? path
    const tab: Tab = {
      id: crypto.randomUUID(),
      kind: 'edit',
      target: $state.snapshot(from.target),
      title,
      status: 'connected',
      edit: { sessionId: from.id, path }
    }
    this.tabs.push(tab)
    this.active = tab.id
  }

  openHost(kind: TabKind, hostId: string, place: Placement | null = null): void {
    const host = this.vault?.hosts.find((h) => h.id === hostId)
    if (!host) return
    if (host.kind === 'rdp') void this.launchRdp({ hostId }, host.label || host.address)
    else this.openTab(kind, { hostId }, host.label || host.address, undefined, {}, place)
  }

  async launchRdp(target: ConnectTarget, title: string): Promise<void> {
    this.toast(`Opening Remote Desktop for ${title}`)
    await api.rdp.launch(target).catch((err) => this.fail(err))
  }

  closeTab(id: string, discard = false): void {
    const i = this.tabs.findIndex((t) => t.id === id)
    if (i < 0) return
    if (this.tabs[i].dirty && !discard) {
      const title = this.tabs[i].title
      void this.confirm('Unsaved changes', `${title} has changes that are not saved.`, 'Close without saving').then(
        (ok) => ok && this.closeTab(id, true)
      )
      return
    }
    const [tab] = this.tabs.splice(i, 1)
    if (tab.kind === 'ssh') void api.ssh.close(id)
    else if (tab.kind === 'sftp' || tab.kind === 'edit') void api.sftp.close(id)
    else void api.docker.close(id)
    this.transfers = this.transfers.filter((t) => t.sessionId !== id)
    const split = this.splitOf(id)
    const next = split && sibling(split.root, id)
    if (split) this.dropPane(split, id)
    if (this.active === id) this.active = next || (this.tabs[Math.min(i, this.tabs.length - 1)]?.id ?? 'home')
    else this.persistTabs()
  }

  closeTabs(ids: string[]): void {
    for (const id of ids) this.closeTab(id)
  }

  closeOtherTabs(keep: string): void {
    const group = new Set(this.paneIds(keep))
    for (const tab of [...this.tabs]) if (!group.has(tab.id)) this.closeTab(tab.id)
    this.active = keep
  }

  cycleTab(step: number): void {
    const ids = ['home', ...this.strip.map((e) => e.tab.id)]
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

  ringBell(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab && !tab.bell) tab.bell = true
  }

  clearBell(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (tab?.bell) tab.bell = false
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

  async askMasterPassword(message: string, confirmLabel = 'Continue'): Promise<string | null> {
    const res = await this.ask({
      title: 'Confirm with your master password',
      message,
      fields: [{ name: 'password', label: 'master password', secret: true }],
      confirmLabel
    })
    return res?.values.password || null
  }

  async askText(title: string, label: string, value = '', confirmLabel = 'Save'): Promise<string | null> {
    const res = await this.ask({ title, fields: [{ name: 'value', label, value }], confirmLabel })
    const text = res?.values.value.trim()
    return text ? text : null
  }

  openPalette(mode: 'all' | 'snippets' = 'all', place: Placement | null = null): void {
    this.paletteMode = mode
    this.palettePlace = place
    this.paletteOpen = true
  }

  openMenu(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault()
    this.menu = { x: event.clientX, y: event.clientY, items }
  }

  openMenuBelow(anchor: HTMLElement, items: MenuItem[]): void {
    const box = anchor.getBoundingClientRect()
    this.menu = { x: box.left, y: box.bottom + 4, items }
  }
}

export const app = new AppState()
