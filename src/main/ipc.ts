import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ConnectTarget,
  DockerAction,
  DockerCommand,
  Host,
  Identity,
  IpcResult,
  LocalState,
  KeyGenRequest,
  KeyImportRequest,
  PromptResponse,
  Settings,
  Snippet,
  SshKey
} from '@shared/types'
import { describeKey, generateKey } from './keys'
import { localFs } from './local-fs'
import { Prompter } from './prompts'
import { importSshConfig } from './ssh-config'
import { SftpSessions } from './ssh/sftp'
import { SyncEngine } from './sync'
import { DockerSessions } from './docker'
import { RdpLauncher } from './rdp'
import { Terminals } from './ssh/terminal'
import type { Vault } from './vault'

function touch<T extends { updatedAt: number }>(items: T[], match: (item: T) => boolean, change: (item: T) => void): void {
  const now = Date.now()
  for (const item of items) {
    if (!match(item)) continue
    change(item)
    item.updatedAt = now
  }
}

export interface Services {
  terminals: Terminals
  sftp: SftpSessions
  prompter: Prompter
  sync: SyncEngine
  docker: DockerSessions
}

export function registerIpc(win: BrowserWindow, vault: Vault): Services {
  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => event.sender === win.webContents

  const prompter = new Prompter(send)
  const terminals = new Terminals(vault, prompter, send)
  const sftp = new SftpSessions(vault, prompter, send)
  const docker = new DockerSessions(vault, prompter, send)
  const rdp = new RdpLauncher(vault, prompter)

  vault.onChange((data) => send('vault:changed', data))
  const sync = new SyncEngine(vault, send)

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<R>> => {
      if (!trusted(event)) return { ok: false, error: 'Untrusted sender' }
      try {
        return { ok: true, value: await fn(...(args as A)) }
      } catch (err) {
        return { ok: false, error: (err as Error).message || String(err) }
      }
    })
  }
  const listen = <A extends unknown[]>(channel: string, fn: (...args: A) => void): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) return
      try {
        fn(...(args as A))
      } catch (err) {
        console.error(`[ipc] ${channel}:`, err)
      }
    })
  }

  handle('vault:status', () => vault.status())
  handle('vault:get', () => (vault.unlocked ? vault.get() : null))
  handle('vault:create', (password: string, remember: boolean) => vault.create(password, remember))
  handle('vault:unlock', (password: string, remember: boolean) => vault.unlock(password, remember))
  handle('vault:lock', () => {
    prompter.cancelAll()
    vault.lock()
  })
  handle('vault:setRemember', async (on: boolean) => {
    await vault.setRemember(on)
    return vault.status()
  })
  handle('vault:changePassword', (current: string, next: string) => vault.changePassword(current, next))

  handle('hosts:save', (host: Host) =>
    vault.mutate((d) => {
      const saved: Host = { ...host, id: host.id || vault.newId(), updatedAt: Date.now() }
      const i = d.hosts.findIndex((h) => h.id === saved.id)
      if (i >= 0) d.hosts[i] = saved
      else d.hosts.push(saved)
      return saved
    })
  )
  handle('hosts:remove', (id: string) =>
    vault.mutate((d) => {
      d.hosts = d.hosts.filter((h) => h.id !== id)
      touch(d.hosts, (h) => h.jumpHostId === id, (h) => (h.jumpHostId = ''))
    })
  )

  const addKey = (req: KeyImportRequest): Promise<SshKey> => {
    const fields = describeKey(req)
    return vault.mutate((d) => {
      if (d.keys.some((k) => k.fingerprint && k.fingerprint === fields.fingerprint)) {
        throw new Error('This key is already in your keychain')
      }
      const now = Date.now()
      const key: SshKey = { ...fields, id: vault.newId(), createdAt: now, updatedAt: now }
      d.keys.push(key)
      return key
    })
  }
  handle('keys:import', (req: KeyImportRequest) => addKey(req))
  handle('keys:generate', (req: KeyGenRequest) => addKey(generateKey(req)))
  handle('keys:rename', (id: string, label: string) =>
    vault.mutate((d) => {
      const key = d.keys.find((k) => k.id === id)
      if (key) {
        key.label = label
        key.updatedAt = Date.now()
      }
    })
  )
  handle('keys:remove', (id: string) =>
    vault.mutate((d) => {
      d.keys = d.keys.filter((k) => k.id !== id)
      touch(d.hosts, (h) => h.keyId === id, (h) => (h.keyId = ''))
      touch(d.identities, (i) => i.keyId === id, (i) => (i.keyId = ''))
    })
  )
  handle('keys:readFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    const path = res.filePaths[0]
    if (res.canceled || !path) return null
    const stat = await fsp.stat(path)
    if (stat.size > 64 * 1024) throw new Error('That file is too large to be a private key')
    return { name: path.split(/[\\/]/).pop() ?? path, content: await fsp.readFile(path, 'utf8') }
  })

  handle('identities:save', (identity: Identity) =>
    vault.mutate((d) => {
      const saved: Identity = { ...identity, id: identity.id || vault.newId(), updatedAt: Date.now() }
      const i = d.identities.findIndex((x) => x.id === saved.id)
      if (i >= 0) d.identities[i] = saved
      else d.identities.push(saved)
      return saved
    })
  )
  handle('identities:remove', (id: string) =>
    vault.mutate((d) => {
      d.identities = d.identities.filter((i) => i.id !== id)
      touch(d.hosts, (h) => h.identityId === id, (h) => (h.identityId = ''))
    })
  )

  handle('snippets:save', (snippet: Snippet) =>
    vault.mutate((d) => {
      const saved: Snippet = { ...snippet, id: snippet.id || vault.newId(), updatedAt: Date.now() }
      const i = d.snippets.findIndex((s) => s.id === saved.id)
      if (i >= 0) d.snippets[i] = saved
      else d.snippets.push(saved)
      return saved
    })
  )
  handle('snippets:remove', (id: string) =>
    vault.mutate((d) => {
      d.snippets = d.snippets.filter((s) => s.id !== id)
    })
  )

  handle('sync:status', () => sync.status())
  handle('sync:create', (url: string, token: string) => sync.create(url, token))
  handle('sync:join', (link: string) => sync.join(link))
  handle('sync:link', () => sync.link())
  handle('sync:now', () => sync.syncNow())
  handle('sync:disconnect', () => sync.disconnect())

  handle('session:save', (state: LocalState) =>
    vault.mutate((d) => {
      d.local = state
    })
  )

  handle('knownHosts:remove', (host: string, keyType: string) =>
    vault.mutate((d) => {
      d.knownHosts = d.knownHosts.filter((k) => !(k.host === host && k.keyType === keyType))
    })
  )

  handle('settings:save', (settings: Settings) =>
    vault.mutate((d) => {
      d.settings = { ...d.settings, ...settings }
    })
  )

  handle('import:sshConfig', () => importSshConfig(vault))

  handle('ssh:open', (id: string, target: ConnectTarget, cols: number, rows: number, command?: string) =>
    terminals.open(id, target, cols, rows, command)
  )
  handle('ssh:close', (id: string) => terminals.close(id))
  listen('ssh:write', (id: string, data: string) => terminals.write(id, data))
  listen('ssh:resize', (id: string, cols: number, rows: number) => terminals.resize(id, cols, rows))
  listen('ssh:ack', (id: string, bytes: number) => terminals.ack(id, bytes))

  handle('sftp:open', (id: string, target: ConnectTarget) => sftp.open(id, target))
  handle('sftp:list', (id: string, path: string) => sftp.list(id, path))
  handle('sftp:realpath', (id: string, path: string) => sftp.realpath(id, path))
  handle('sftp:mkdir', (id: string, path: string) => sftp.mkdir(id, path))
  handle('sftp:rename', (id: string, from: string, to: string) => sftp.rename(id, from, to))
  handle('sftp:chmod', (id: string, path: string, mode: number) => sftp.chmod(id, path, mode))
  handle('sftp:remove', (id: string, paths: string[]) => sftp.remove(id, paths))
  handle('sftp:upload', (id: string, paths: string[], dir: string) => sftp.upload(id, paths, dir))
  handle('sftp:download', (id: string, paths: string[], dir: string) => sftp.download(id, paths, dir))
  handle('sftp:cancel', (transferId: string) => sftp.cancel(transferId))
  handle('sftp:close', (id: string) => sftp.close(id))
  handle('sftp:edit', (id: string, path: string) => sftp.editor.open(id, path))
  handle('sftp:editStop', (id: string, path: string) => sftp.editor.stop(id, path))

  handle('rdp:launch', (hostId: string) => rdp.launch(hostId))

  handle('docker:open', (id: string, target: ConnectTarget) => docker.open(id, target))
  handle('docker:list', (id: string) => docker.list(id))
  handle('docker:stats', (id: string) => docker.stats(id))
  handle('docker:action', (id: string, containerId: string, action: DockerAction) => docker.action(id, containerId, action))
  handle('docker:command', (id: string, containerId: string, kind: DockerCommand) => docker.command(id, containerId, kind))
  handle('docker:close', (id: string) => docker.close(id))

  handle('local:home', () => localFs.home())
  handle('local:list', (path: string) => localFs.list(path))
  handle('local:mkdir', (path: string) => localFs.mkdir(path))
  handle('local:rename', (from: string, to: string) => localFs.rename(from, to))
  handle('local:trash', (paths: string[]) => localFs.trash(paths))
  handle('local:open', (path: string) => localFs.open(path))

  listen('prompt:respond', (id: string, res: PromptResponse | null) => prompter.respond(id, res))
  listen('window:focus', () => {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  listen('window:minimize', () => win.minimize())
  listen('window:toggleMaximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()))
  listen('window:close', () => win.close())
  handle('window:isMaximized', () => win.isMaximized())
  win.on('maximize', () => send('window:maximized', true))
  win.on('unmaximize', () => send('window:maximized', false))
  listen('app:copy', (text: string) => {
    if (typeof text === 'string' && text.length <= 1024 * 1024) clipboard.writeText(text)
  })
  listen('app:openExternal', (url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  return { terminals, sftp, prompter, sync, docker }
}
