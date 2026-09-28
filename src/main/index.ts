import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc, type Services } from './ipc'
import { Vault } from './vault'

const TITLEBAR_HEIGHT = 40
if (process.env.BAWKTERM_DATA_DIR) app.setPath('userData', process.env.BAWKTERM_DATA_DIR)
let services: Services | undefined

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
    titleBarOverlay:
      process.platform === 'darwin' ? true : { color: '#141010', symbolColor: '#b8b2b2', height: TITLEBAR_HEIGHT },
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
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  services = registerIpc(win, vault)
  win.on('focus', () => services?.sync.poke())
  win.on('closed', () => {
    services?.terminals.closeAll()
    services?.sftp.closeAll()
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
    const vault = new Vault()
    await vault.tryAutoUnlock()
    createWindow(vault)
  })

  app.on('window-all-closed', () => app.quit())
}
