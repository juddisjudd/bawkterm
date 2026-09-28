import { app, BrowserWindow, Menu, net, protocol, shell } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc, type Services } from './ipc'
import { Vault } from './vault'

if (process.env.BAWKTERM_DATA_DIR) app.setPath('userData', process.env.BAWKTERM_DATA_DIR)
let services: Services | undefined

// The renderer is served from this https origin (answered locally, never fetched) so passkeys have a valid RP ID.
const APP_HOST = 'bawkterm.bawkbawk.net'

function serveRenderer(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('https', (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('blocked', { status: 403 })
    const file = normalize(join(root, decodeURIComponent(url.pathname)))
    if (file !== root && !file.startsWith(root + sep)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file === root ? join(root, 'index.html') : file).toString())
  })
}

function createWindow(vault: Vault): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#141010',
    title: 'bawkterm',
    icon: app.isPackaged ? undefined : join(app.getAppPath(), 'build/icon.ico'),
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

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

  services = registerIpc(win, vault)
  win.on('focus', () => services?.sync.poke())
  win.on('closed', () => {
    services?.terminals.closeAll()
    services?.sftp.closeAll()
    services?.docker.closeAll()
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
    app.setAppUserModelId('dev.bawkterm')
    Menu.setApplicationMenu(null)
    if (app.isPackaged || !process.env['ELECTRON_RENDERER_URL']) serveRenderer()
    const vault = new Vault()
    await vault.tryAutoUnlock()
    createWindow(vault)
  })

  app.on('window-all-closed', () => app.quit())
}
