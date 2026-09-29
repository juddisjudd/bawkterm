import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BawkApi } from '@shared/api'
import type { IpcResult } from '@shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BawkApi = {
  platform: process.platform,
  vault: {
    status: () => invoke('vault:status'),
    get: () => invoke('vault:get'),
    create: (password, remember) => invoke('vault:create', password, remember),
    unlock: (password, remember) => invoke('vault:unlock', password, remember),
    lock: () => invoke('vault:lock'),
    setRemember: (on) => invoke('vault:setRemember', on),
    changePassword: (current, next) => invoke('vault:changePassword', current, next),
    onChanged: (cb) => on('vault:changed', cb)
  },
  unlock: {
    status: () => invoke('unlock:status'),
    hello: () => invoke('unlock:hello'),
    enableHello: () => invoke('unlock:enableHello'),
    disableHello: () => invoke('unlock:disableHello'),
    passkey: (prfOutput) => invoke('unlock:passkey', prfOutput),
    enablePasskey: (enrollment, prfOutput) => invoke('unlock:enablePasskey', enrollment, prfOutput),
    disablePasskey: () => invoke('unlock:disablePasskey')
  },
  hosts: {
    save: (host) => invoke('hosts:save', host),
    remove: (id) => invoke('hosts:remove', id)
  },
  keys: {
    import: (req) => invoke('keys:import', req),
    generate: (req) => invoke('keys:generate', req),
    rename: (id, label) => invoke('keys:rename', id, label),
    remove: (id) => invoke('keys:remove', id),
    readFile: () => invoke('keys:readFile')
  },
  identities: {
    save: (identity) => invoke('identities:save', identity),
    remove: (id) => invoke('identities:remove', id)
  },
  snippets: {
    save: (snippet) => invoke('snippets:save', snippet),
    remove: (id) => invoke('snippets:remove', id)
  },
  sync: {
    status: () => invoke('sync:status'),
    create: (url, token) => invoke('sync:create', url, token),
    join: (link) => invoke('sync:join', link),
    link: () => invoke('sync:link'),
    now: () => invoke('sync:now'),
    disconnect: () => invoke('sync:disconnect'),
    onStatus: (cb) => on('sync:status', cb)
  },
  session: {
    save: (state) => invoke('session:save', state)
  },
  knownHosts: {
    remove: (host, keyType) => invoke('knownHosts:remove', host, keyType)
  },
  settings: {
    save: (settings) => invoke('settings:save', settings)
  },
  importSshConfig: () => invoke('import:sshConfig'),
  ssh: {
    open: (sessionId, target, cols, rows, command) => invoke('ssh:open', sessionId, target, cols, rows, command),
    write: (sessionId, data) => ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    ack: (sessionId, bytes) => ipcRenderer.send('ssh:ack', sessionId, bytes),
    close: (sessionId) => invoke('ssh:close', sessionId),
    onData: (cb) => on('ssh:data', cb),
    onStatus: (cb) => on('ssh:status', cb)
  },
  sftp: {
    open: (sessionId, target) => invoke('sftp:open', sessionId, target),
    list: (sessionId, path) => invoke('sftp:list', sessionId, path),
    realpath: (sessionId, path) => invoke('sftp:realpath', sessionId, path),
    mkdir: (sessionId, path) => invoke('sftp:mkdir', sessionId, path),
    rename: (sessionId, from, to) => invoke('sftp:rename', sessionId, from, to),
    chmod: (sessionId, path, mode) => invoke('sftp:chmod', sessionId, path, mode),
    remove: (sessionId, paths) => invoke('sftp:remove', sessionId, paths),
    upload: (sessionId, localPaths, remoteDir) => invoke('sftp:upload', sessionId, localPaths, remoteDir),
    download: (sessionId, remotePaths, localDir) => invoke('sftp:download', sessionId, remotePaths, localDir),
    cancel: (transferId) => invoke('sftp:cancel', transferId),
    close: (sessionId) => invoke('sftp:close', sessionId),
    onStatus: (cb) => on('sftp:status', cb),
    onTransfer: (cb) => on('sftp:transfer', cb),
    readText: (id, path) => invoke('sftp:readText', id, path),
    writeText: (id, path, text, bom, expected) => invoke('sftp:writeText', id, path, text, bom, expected),
    edit: (sessionId, remotePath) => invoke('sftp:edit', sessionId, remotePath),
    editStop: (sessionId, remotePath) => invoke('sftp:editStop', sessionId, remotePath),
    onEdit: (cb) => on('sftp:edit', cb)
  },
  rdp: {
    launch: (hostId) => invoke('rdp:launch', hostId)
  },
  docker: {
    open: (sessionId, target) => invoke('docker:open', sessionId, target),
    list: (sessionId) => invoke('docker:list', sessionId),
    stats: (sessionId) => invoke('docker:stats', sessionId),
    action: (sessionId, containerId, action) => invoke('docker:action', sessionId, containerId, action),
    command: (sessionId, containerId, kind) => invoke('docker:command', sessionId, containerId, kind),
    close: (sessionId) => invoke('docker:close', sessionId),
    onStatus: (cb) => on('docker:status', cb)
  },
  local: {
    home: () => invoke('local:home'),
    list: (path) => invoke('local:list', path),
    mkdir: (path) => invoke('local:mkdir', path),
    rename: (from, to) => invoke('local:rename', from, to),
    trash: (paths) => invoke('local:trash', paths),
    open: (path) => invoke('local:open', path)
  },
  prompts: {
    onRequest: (cb) => on('prompt:request', cb),
    onCancel: (cb) => on('prompt:cancel', cb),
    respond: (id, res) => ipcRenderer.send('prompt:respond', id, res)
  },
  win: {
    focus: () => ipcRenderer.send('window:focus'),
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
    onMaximized: (cb) => on('window:maximized', cb)
  },
  app: {
    openExternal: (url) => ipcRenderer.send('app:openExternal', url),
    copy: (text) => ipcRenderer.send('app:copy', text),
    pathForFile: (file) => webUtils.getPathForFile(file),
    editors: () => invoke('app:editors'),
    pickEditor: () => invoke('app:pickEditor')
  }
}

contextBridge.exposeInMainWorld('api', api)
