import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { SECRET_KEPT } from '@shared/defaults'
import type { Host, Identity, IpcResult, SshKey, VaultData } from '@shared/types'
import { describeKey, generateKey } from './keys'
import { localFs } from './local-fs'
import { Prompter } from './prompts'
import { importSshConfig } from './ssh-config'
import { SftpSessions } from './ssh/sftp'
import { SyncEngine, encodeLink } from './sync'
import { DockerSessions } from './docker'
import { RdpLauncher } from './rdp'
import { UnlockMethods } from './unlock'
import { Terminals } from './ssh/terminal'
import type { Vault } from './vault'
import { detectEditors, pickEditor } from './editors'
import { Updater } from './updater'
import {
  bool,
  cleanEnrollment,
  cleanHost,
  cleanIdentity,
  cleanKeyGen,
  cleanKeyImport,
  cleanLocalState,
  cleanPromptResponse,
  cleanSettings,
  cleanSnippet,
  cleanTarget,
  dockerAction,
  dockerCommand,
  id,
  int,
  line,
  oneOf,
  path,
  paths,
  text
} from './validate'

const CLIPBOARD_CLEAR_MS = 60_000
const RUNNABLE = /\.(exe|com|bat|cmd|msi|msp|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|pif|lnk|url|reg|cpl|jar|py|pyw|appref-ms|application|msc|scf|chm|inf|settingcontent-ms|desktop|appimage|sh|bash|run|bin|elf|deb|rpm|flatpakref)$/i

function touch<T extends { updatedAt: number }>(items: T[], match: (item: T) => boolean, change: (item: T) => void): void {
  const now = Date.now()
  for (const item of items) {
    if (!match(item)) continue
    change(item)
    item.updatedAt = now
  }
}

const kept = (secret: string): string => (secret ? SECRET_KEPT : '')

// the window never holds passwords, private keys or the sync key; it sees SECRET_KEPT where one is stored
const redactHost = (h: Host): Host => ({ ...h, password: kept(h.password) })
const redactIdentity = (i: Identity): Identity => ({ ...i, password: kept(i.password) })
const redactKey = (k: SshKey): SshKey => ({ ...k, privateKey: SECRET_KEPT, passphrase: kept(k.passphrase) })

export function redact(d: VaultData | null): VaultData | null {
  if (!d) return null
  return {
    ...d,
    hosts: d.hosts.map(redactHost),
    keys: d.keys.map(redactKey),
    identities: d.identities.map(redactIdentity),
    sync: { ...d.sync, config: d.sync.config && { url: d.sync.config.url, token: SECRET_KEPT, key: SECRET_KEPT } }
  }
}

const restore = (incoming: string, stored: string | undefined): string => (incoming === SECRET_KEPT ? (stored ?? '') : incoming)

export interface Services {
  terminals: Terminals
  sftp: SftpSessions
  prompter: Prompter
  sync: SyncEngine
  docker: DockerSessions
  rdp: RdpLauncher
  updater: Updater
}

export function registerIpc(win: BrowserWindow, vault: Vault, origins: string[]): Services {
  const send = (channel: string, ...args: unknown[]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false
    try {
      return origins.includes(new URL(event.senderFrame.url).origin)
    } catch {
      return false
    }
  }

  const prompter = new Prompter(send)
  const terminals = new Terminals(vault, prompter, send)
  const sftp = new SftpSessions(vault, prompter, send)
  const docker = new DockerSessions(vault, prompter, send)
  const rdp = new RdpLauncher(vault, prompter)
  const unlock = new UnlockMethods(vault)
  const updater = new Updater(vault, send)

  vault.onChange((data) => send('vault:changed', redact(data)))
  const sync = new SyncEngine(vault, send)

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!trusted(event)) return { ok: false, error: 'Untrusted sender' }
      try {
        return { ok: true, value: await fn(...args) }
      } catch (err) {
        return { ok: false, error: (err as Error).message || String(err) }
      }
    })
  }
  const listen = (channel: string, fn: (...args: unknown[]) => void): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) return
      try {
        fn(...args)
      } catch (err) {
        console.error(`[ipc] ${channel}:`, (err as Error).message)
      }
    })
  }
  const password = (v: unknown): string => text(v, 'password')
  const size = (v: unknown): number => int(v, 'size', 1, 10_000)

  handle('vault:status', () => vault.status())
  handle('vault:get', () => (vault.unlocked ? redact(vault.get()) : null))
  handle('vault:create', async (pw, remember) => redact(await vault.create(password(pw), bool(remember, 'remember'))))
  handle('vault:unlock', async (pw, remember) => redact(await vault.unlock(password(pw), bool(remember, 'remember'))))
  handle('vault:lock', () => {
    prompter.cancelAll()
    vault.lock()
  })
  handle('vault:verifyPassword', (pw) => vault.verifyPassword(password(pw)))
  // turning auto-unlock on grants lasting access, so it needs the master password; turning it off does not
  handle('vault:setRemember', async (on, pw) => {
    if (bool(on, 'remember')) await vault.verifyPassword(password(pw))
    await vault.setRemember(on as boolean)
    return vault.status()
  })
  handle('vault:changePassword', async (current, next) => {
    await vault.changePassword(password(current), password(next))
    await unlock.revokeAll()
  })

  handle('unlock:status', () => unlock.status())
  handle('unlock:hello', async () => redact(await unlock.unlockWithHello()))
  handle('unlock:enableHello', async (pw) => {
    await vault.verifyPassword(password(pw))
    await unlock.enableHello()
  })
  handle('unlock:disableHello', () => unlock.disableHello())
  handle('unlock:passkey', async (prf) => redact(await unlock.unlockWithPasskey(line(prf, 'passkey answer', 1024))))
  handle('unlock:enablePasskey', async (enrollment, prf, pw) => {
    await vault.verifyPassword(password(pw))
    await unlock.enablePasskey(cleanEnrollment(enrollment), line(prf, 'passkey answer', 1024))
  })
  handle('unlock:disablePasskey', () => unlock.disablePasskey())

  handle('secrets:reveal', async (kind, itemId, pw) => {
    await vault.verifyPassword(password(pw))
    const d = vault.get()
    const which = oneOf(kind, 'secret', ['host', 'identity'] as const)
    const key = id(itemId)
    const item = which === 'host' ? d.hosts.find((h) => h.id === key) : d.identities.find((i) => i.id === key)
    if (!item) throw new Error('Not found')
    return item.password
  })

  handle('hosts:save', (input) => {
    const host = cleanHost(input)
    return vault.mutate((d) => {
      const i = d.hosts.findIndex((h) => h.id === host.id)
      const stored = i >= 0 ? d.hosts[i] : undefined
      const saved: Host = {
        ...host,
        id: host.id || vault.newId(),
        password: restore(host.password, stored?.password),
        lastUsedAt: stored?.lastUsedAt,
        updatedAt: Date.now()
      }
      if (stored) d.hosts[i] = saved
      else d.hosts.push(saved)
      return redactHost(saved)
    })
  })
  handle('hosts:remove', (hostId) => {
    const key = id(hostId)
    return vault.mutate((d) => {
      d.hosts = d.hosts.filter((h) => h.id !== key)
      touch(d.hosts, (h) => h.jumpHostId === key, (h) => (h.jumpHostId = ''))
    })
  })

  const addKey = (fields: Omit<SshKey, 'id' | 'createdAt' | 'updatedAt'>): Promise<SshKey> =>
    vault.mutate((d) => {
      if (d.keys.some((k) => k.fingerprint && k.fingerprint === fields.fingerprint)) {
        throw new Error('This key is already in your keychain')
      }
      const now = Date.now()
      const key: SshKey = { ...fields, id: vault.newId(), createdAt: now, updatedAt: now }
      d.keys.push(key)
      return redactKey(key)
    })
  handle('keys:import', (req) => addKey(describeKey(cleanKeyImport(req))))
  handle('keys:generate', (req) => addKey(describeKey(generateKey(cleanKeyGen(req)))))
  handle('keys:rename', (keyId, label) => {
    const key = id(keyId)
    const name = line(label, 'label', 256)
    return vault.mutate((d) => {
      const found = d.keys.find((k) => k.id === key)
      if (found) {
        found.label = name
        found.updatedAt = Date.now()
      }
    })
  })
  handle('keys:remove', (keyId) => {
    const key = id(keyId)
    return vault.mutate((d) => {
      d.keys = d.keys.filter((k) => k.id !== key)
      touch(d.hosts, (h) => h.keyId === key, (h) => (h.keyId = ''))
      touch(d.identities, (i) => i.keyId === key, (i) => (i.keyId = ''))
    })
  })
  handle('keys:readFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    const file = res.filePaths[0]
    if (res.canceled || !file) return null
    const stat = await fsp.stat(file)
    if (stat.size > 64 * 1024) throw new Error('That file is too large to be a private key')
    return { name: basename(file), content: await fsp.readFile(file, 'utf8') }
  })

  handle('identities:save', (input) => {
    const identity = cleanIdentity(input)
    return vault.mutate((d) => {
      const i = d.identities.findIndex((x) => x.id === identity.id)
      const stored = i >= 0 ? d.identities[i] : undefined
      const saved: Identity = {
        ...identity,
        id: identity.id || vault.newId(),
        password: restore(identity.password, stored?.password),
        updatedAt: Date.now()
      }
      if (stored) d.identities[i] = saved
      else d.identities.push(saved)
      return redactIdentity(saved)
    })
  })
  handle('identities:remove', (identityId) => {
    const key = id(identityId)
    return vault.mutate((d) => {
      d.identities = d.identities.filter((i) => i.id !== key)
      touch(d.hosts, (h) => h.identityId === key, (h) => (h.identityId = ''))
    })
  })

  handle('snippets:save', (input) => {
    const snippet = cleanSnippet(input)
    return vault.mutate((d) => {
      const saved = { ...snippet, id: snippet.id || vault.newId(), updatedAt: Date.now() }
      const i = d.snippets.findIndex((s) => s.id === saved.id)
      if (i >= 0) d.snippets[i] = saved
      else d.snippets.push(saved)
      return saved
    })
  })
  handle('snippets:remove', (snippetId) => {
    const key = id(snippetId)
    return vault.mutate((d) => {
      d.snippets = d.snippets.filter((s) => s.id !== key)
    })
  })

  handle('sync:status', () => sync.status())
  handle('sync:check', (url, token) => sync.check(line(url, 'server address', 2048), line(token, 'token', 1024)))
  handle('sync:create', (url, token, erase) =>
    sync.create(line(url, 'server address', 2048), line(token, 'token', 1024), erase === true)
  )
  handle('sync:join', (link) => sync.join(line(link, 'sync link', 8192)))
  // the link is the server token plus the encryption key, so it goes straight to the clipboard and is wiped again
  handle('sync:copyLink', async (pw) => {
    await vault.verifyPassword(password(pw))
    const config = vault.get().sync.config
    if (!config) throw new Error('Sync is not set up')
    const link = encodeLink(config)
    clipboard.writeText(link)
    setTimeout(() => {
      void Promise.resolve(clipboard.readText()).then((current) => current === link && clipboard.clear())
    }, CLIPBOARD_CLEAR_MS)
  })
  handle('sync:now', () => sync.syncNow())
  handle('sync:disconnect', () => sync.disconnect())

  handle('session:save', (state) => {
    const local = cleanLocalState(state)
    return vault.mutate((d) => {
      d.local = local
    })
  })

  handle('knownHosts:remove', (host, keyType) => {
    const h = line(host, 'known host', 300)
    const t = line(keyType, 'key type', 64)
    return vault.mutate((d) => {
      d.knownHosts = d.knownHosts.filter((k) => !(k.host === h && k.keyType === t))
    })
  })

  handle('settings:save', (settings) => {
    const clean = cleanSettings(settings)
    return vault.mutate((d) => {
      d.settings = { ...d.settings, ...clean }
    })
  })

  handle('import:sshConfig', () => importSshConfig(vault))

  handle('ssh:open', (sid, target, cols, rows, command) =>
    terminals.open(id(sid), cleanTarget(target), size(cols), size(rows), command === undefined ? undefined : text(command, 'command'))
  )
  handle('ssh:close', (sid) => terminals.close(id(sid)))
  listen('ssh:write', (sid, data) => terminals.write(id(sid), text(data, 'input', 16 * 1024 * 1024)))
  listen('ssh:resize', (sid, cols, rows) => terminals.resize(id(sid), size(cols), size(rows)))
  listen('ssh:ack', (sid, bytes) => terminals.ack(id(sid), int(bytes, 'bytes', 0, 1024 ** 3)))

  handle('sftp:open', (sid, target) => sftp.open(id(sid), cleanTarget(target)))
  handle('sftp:list', (sid, p) => sftp.list(id(sid), path(p)))
  handle('sftp:realpath', (sid, p) => sftp.realpath(id(sid), path(p)))
  handle('sftp:mkdir', (sid, p) => sftp.mkdir(id(sid), path(p)))
  handle('sftp:rename', (sid, from, to) => sftp.rename(id(sid), path(from), path(to)))
  handle('sftp:chmod', (sid, p, mode) => sftp.chmod(id(sid), path(p), int(mode, 'mode', 0, 0o7777)))
  handle('sftp:remove', (sid, list) => sftp.remove(id(sid), paths(list)))
  handle('sftp:upload', (sid, list, dir) => sftp.upload(id(sid), paths(list), path(dir)))
  handle('sftp:download', (sid, list, dir) => sftp.download(id(sid), paths(list), path(dir)))
  handle('sftp:cancel', (transferId) => sftp.cancel(id(transferId)))
  handle('sftp:close', (sid) => sftp.close(id(sid)))
  handle('sftp:readText', (sid, p) => sftp.readText(id(sid), path(p)))
  handle('sftp:writeText', (sid, p, content, bom, expected) => {
    const stat =
      expected === null
        ? null
        : {
            mtime: int((expected as { mtime?: unknown })?.mtime, 'file date', 0, 2 ** 53 - 1),
            size: int((expected as { size?: unknown })?.size, 'file size', 0, 2 ** 53 - 1)
          }
    return sftp.writeText(id(sid), path(p), text(content, 'file', 5 * 1024 * 1024), bool(bom, 'encoding'), stat)
  })
  handle('sftp:edit', (sid, p) => sftp.editor.open(id(sid), path(p)))
  handle('sftp:editStop', (sid, p) => sftp.editor.stop(id(sid), path(p)))

  handle('rdp:launch', (hostId) => rdp.launch(id(hostId)))

  handle('docker:open', (sid, target) => docker.open(id(sid), cleanTarget(target)))
  handle('docker:list', (sid) => docker.list(id(sid)))
  handle('docker:stats', (sid) => docker.stats(id(sid)))
  handle('docker:action', (sid, containerId, action) => docker.action(id(sid), line(containerId, 'container', 64), dockerAction(action)))
  handle('docker:command', (sid, containerId, kind) => docker.command(id(sid), line(containerId, 'container', 64), dockerCommand(kind)))
  handle('docker:close', (sid) => docker.close(id(sid)))

  handle('local:home', () => localFs.home())
  handle('local:list', (p) => localFs.list(path(p)))
  handle('local:mkdir', (p) => localFs.mkdir(path(p)))
  handle('local:rename', (from, to) => localFs.rename(path(from), path(to)))
  handle('local:trash', (list) => localFs.trash(paths(list)))
  // the main process asks, so even a compromised window cannot run a program without the user seeing it
  handle('local:open', async (p) => {
    const file = path(p)
    if (RUNNABLE.test(file)) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Run this file?',
        message: `"${basename(file)}" is a program or script. Opening it runs it on this PC.`,
        detail: file,
        buttons: ['Cancel', 'Run it'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (response !== 1) return
    }
    return localFs.open(file)
  })

  listen('prompt:respond', (promptId, res) => prompter.respond(id(promptId), cleanPromptResponse(res)))
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
  listen('app:copy', (value) => clipboard.writeText(text(value, 'text', 1024 * 1024)))
  handle('update:status', () => updater.get())
  handle('update:check', () => updater.check(true))
  handle('update:install', () => updater.install())
  handle('app:editors', () => detectEditors())
  handle('app:pickEditor', () => pickEditor(win))
  listen('app:openExternal', (url) => {
    const target = line(url, 'link', 8192)
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
  })

  return { terminals, sftp, prompter, sync, docker, rdp, updater }
}
