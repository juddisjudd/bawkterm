import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '@shared/types'
import type { Send } from './prompts'
import type { Vault } from './vault'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15_000

type InstallKind = 'nsis' | 'appimage' | 'deb' | 'rpm'

// only installs bawkterm can replace itself; Flatpak, AUR and the tar.gz are updated by their package managers,
// and macOS only installs updates to apps signed with a Developer ID
function installKind(): InstallKind | null {
  if (!app.isPackaged) return null
  if (process.platform === 'win32') return 'nsis'
  if (process.platform !== 'linux' || process.env.FLATPAK_ID) return null
  if (process.env.APPIMAGE) return 'appimage'
  const file = join(process.resourcesPath, 'package-type')
  const type = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  return type === 'deb' || type === 'rpm' ? type : null
}

// Updates come from this repository's GitHub releases. electron-updater checks each download against the
// sha512 published in latest.yml / latest-linux.yml before it will install it.
export class Updater {
  private status: UpdateStatus
  private lastCheck = 0
  private timer?: NodeJS.Timeout

  constructor(
    private vault: Vault,
    private send: Send
  ) {
    const kind = installKind()
    const managedBy = !app.isPackaged
      ? 'dev'
      : process.env.FLATPAK_ID
        ? 'flatpak'
        : process.platform === 'darwin'
          ? 'manual'
          : 'package'
    this.status = kind ? { supported: true, state: 'idle' } : { supported: false, managedBy, state: 'idle' }
    if (!kind) return
    autoUpdater.logger = null
    autoUpdater.autoDownload = true
    autoUpdater.allowPrerelease = false
    // deb and rpm installs ask for a system password, so they only install when the user chooses to restart
    autoUpdater.autoInstallOnAppQuit = kind === 'nsis' || kind === 'appimage'
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: undefined }))
    autoUpdater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none', version: undefined, percent: undefined }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, percent: 100 }))
    autoUpdater.on('error', (err) =>
      this.set({ state: 'error', error: (err.message.split('\n')[0] || 'Update check failed').slice(0, 200) })
    )
    // settings live in the encrypted vault, so automatic checks wait for an unlock
    vault.onChange((data) => {
      if (data && Date.now() - this.lastCheck > CHECK_EVERY_MS) void this.check(false)
    })
  }

  get(): UpdateStatus {
    return this.status
  }

  start(): void {
    if (!this.status.supported) return
    setTimeout(() => void this.check(false), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS)
  }

  async check(manual: boolean): Promise<UpdateStatus> {
    if (!this.status.supported) return this.status
    if (!manual && !(this.vault.unlocked && this.vault.get().settings.autoUpdate)) return this.status
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'ready') {
      return this.status
    }
    this.lastCheck = Date.now()
    await autoUpdater.checkForUpdates().catch(() => {})
    return this.status
  }

  install(): void {
    if (this.status.state !== 'ready') throw new Error('No update is ready to install')
    autoUpdater.quitAndInstall(false, true)
  }

  dispose(): void {
    clearInterval(this.timer)
  }

  private set(change: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...change }
    this.send('update:status', this.status)
  }
}
