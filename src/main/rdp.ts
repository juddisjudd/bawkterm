import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Prompter } from './prompts'
import type { Vault } from './vault'
import { closeConnection, connect, type Connection } from './ssh/connect'

const CLEANUP_MS = 30_000

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve()))
  )
}

export function rdpFile(address: string, username: string, fullscreen: boolean): string {
  return [
    `full address:s:${address}`,
    username ? `username:s:${username}` : '',
    `screen mode id:i:${fullscreen ? 2 : 1}`,
    'dynamic resolution:i:1',
    'smart sizing:i:1',
    'redirectclipboard:i:1',
    'autoreconnection enabled:i:1',
    'authentication level:i:2',
    'prompt for credentials:i:0',
    'promptcredentialonce:i:1'
  ]
    .filter(Boolean)
    .join('\r\n')
}

export async function tunnel(conn: Connection, host: string, port: number): Promise<Server> {
  const server = createServer((socket) => {
    conn.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) {
        socket.destroy()
        return
      }
      socket.pipe(stream).pipe(socket)
      socket.on('error', () => stream.destroy())
      stream.on('error', () => socket.destroy())
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

export class RdpLauncher {
  constructor(
    private vault: Vault,
    private prompter: Prompter
  ) {}

  async launch(hostId: string): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Opening Remote Desktop needs Windows')
    const data = this.vault.get()
    const host = data.hosts.find((h) => h.id === hostId)
    if (!host || host.kind !== 'rdp') throw new Error('RDP host not found')
    const identity = host.identityId ? data.identities.find((i) => i.id === host.identityId) : undefined
    const username = host.username || identity?.username || ''
    const password = host.password || identity?.password || ''

    let target = host.address
    let port = host.port || 3389
    let conn: Connection | undefined
    let server: Server | undefined
    if (host.jumpHostId) {
      const sessionId = `rdp:${randomUUID()}`
      conn = await connect({ hostId: host.jumpHostId }, {
        vault: this.vault,
        ask: this.prompter.forSession(sessionId),
        signal: new AbortController().signal
      })
      server = await tunnel(conn, host.address, port)
      target = '127.0.0.1'
      port = (server.address() as AddressInfo).port
    }
    const address = port === 3389 ? target : `${target}:${port}`

    const credential = `TERMSRV/${target}`
    if (username && password) await run('cmdkey', [`/generic:${credential}`, `/user:${username}`, `/pass:${password}`])

    const dir = join(tmpdir(), 'bawkterm-rdp')
    await fsp.mkdir(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}.rdp`)
    await fsp.writeFile(file, rdpFile(address, username, host.rdpFullscreen), 'utf8')

    const child = spawn('mstsc.exe', [file], { stdio: 'ignore', windowsHide: false })
    const cleanup = (): void => {
      server?.close()
      if (conn) closeConnection(conn)
    }
    child.once('error', cleanup)
    child.once('exit', cleanup)
    setTimeout(() => {
      void fsp.rm(file, { force: true })
      if (username && password) void run('cmdkey', [`/delete:${credential}`]).catch(() => {})
    }, CLEANUP_MS)

    await this.vault.mutate((d) => {
      const stored = d.hosts.find((h) => h.id === hostId)
      if (stored) stored.lastUsedAt = Date.now()
    })
  }
}
