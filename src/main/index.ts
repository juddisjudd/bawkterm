import { app, BrowserWindow, Menu, nativeImage, nativeTheme, net, powerMonitor, protocol, session, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, type Services } from './ipc'
import { sweepRdpCredentials } from './rdp'
import { sweepEditFiles } from './ssh/remote-edit'
import { system32 } from './system'
import { Vault } from './vault'

// an installed copy never attaches a debugger, which could read the unlocked vault
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags']
if (app.isPackaged && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1)
  process.exit(1)
}

if (!app.isPackaged && process.env.BAWKTERM_DATA_DIR) app.setPath('userData', process.env.BAWKTERM_DATA_DIR)
let services: Services | undefined

// The renderer is served from this https origin (answered locally, never fetched) so passkeys have a valid RP ID.
// Forks should change it to a host they control.
const APP_HOST = 'bawkterm.bawkbawk.net'
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self'; frame-ancestors 'none'"
const ORIGINS = [
  `https://${APP_HOST}`,
  ...(!app.isPackaged && process.env['ELECTRON_RENDERER_URL'] ? [new URL(process.env['ELECTRON_RENDERER_URL']).origin] : [])
]

function iconFile(light: boolean): string {
  const name = `${light ? 'icon-light' : 'icon'}.${process.platform === 'win32' ? 'ico' : 'png'}`
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build', name)
}

// the taskbar follows the Windows mode, which can differ from the app mode nativeTheme reports
function taskbarIsLight(): boolean {
  if (process.platform !== 'win32') return !nativeTheme.shouldUseDarkColors
  try {
    const out = execFileSync(
      system32('reg.exe'),
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme'],
      { encoding: 'utf8', windowsHide: true }
    )
    return /SystemUsesLightTheme\s+REG_DWORD\s+0x1\b/.test(out)
  } catch {
    return !nativeTheme.shouldUseDarkColors
  }
}

function serveRenderer(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('https', async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('blocked', { status: 403 })
    const file = normalize(join(root, decodeURIComponent(url.pathname)))
    if (file !== root && !file.startsWith(root + sep)) return new Response('not found', { status: 404 })
    const target = file === root ? join(root, 'index.html') : file
    const res = await net.fetch(pathToFileURL(target).toString())
    if (!target.endsWith('.html')) return res
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', CSP)
    return new Response(res.body, { status: res.status, headers })
  })
}

// only the clipboard and notifications, and only for the app's own page
function lockPermissions(): void {
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications'])
  const fromApp = (url: string): boolean => {
    try {
      return ORIGINS.includes(new URL(url).origin)
    } catch {
      return false
    }
  }
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(allowed.has(permission) && fromApp(details.requestingUrl))
  )
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && fromApp(origin))
  ses.setDevicePermissionHandler(() => false)
}

// macOS needs a menu for Cmd+C, Cmd+V and Cmd+Q to work; the other platforms get none
function setMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
}

function createWindow(vault: Vault): BrowserWindow {
  const mac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#13100f',
    title: 'bawkterm',
    ...(mac ? { trafficLightPosition: { x: 14, y: 12 } } : { icon: iconFile(taskbarIsLight()) }),
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())
  if (!mac) {
    const onTheme = (): void => win.setIcon(nativeImage.createFromPath(iconFile(taskbarIsLight())))
    nativeTheme.on('updated', onTheme)
    win.once('closed', () => nativeTheme.off('updated', onTheme))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')
    if (devtools && !app.isPackaged) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadURL(`https://${APP_HOST}/index.html`)
  }

  services = registerIpc(win, vault, ORIGINS)
  services.updater.start()
  win.on('focus', () => services?.sync.poke())
  win.on('closed', () => {
    services?.terminals.closeAll()
    void services?.local.closeAll()
    services?.sftp.closeAll()
    services?.docker.closeAll()
    services?.updater.dispose()
  })
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('dev.bawkterm')
    setMenu()
    lockPermissions()
    sweepEditFiles()
    sweepRdpCredentials()
    if (app.isPackaged || !process.env['ELECTRON_RENDERER_URL']) serveRenderer()
    const vault = new Vault()
    await vault.tryAutoUnlock()
    createWindow(vault)
    const lockWithSystem = (): void => {
      if (!vault.unlocked || !vault.get().settings.lockOnSystemLock) return
      services?.prompter.cancelAll()
      vault.lock()
    }
    powerMonitor.on('lock-screen', lockWithSystem)
    powerMonitor.on('suspend', lockWithSystem)
  })

  app.on('will-quit', (e) => {
    if (services?.local.busy) {
      e.preventDefault()
      void services.local.closeAll().then(() => app.quit())
      return
    }
    services?.sftp.editor.disposeAll()
    services?.rdp.dispose()
  })
  app.on('window-all-closed', () => app.quit())
}
