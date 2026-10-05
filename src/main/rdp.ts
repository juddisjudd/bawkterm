import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, promises as fsp } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectTarget } from '@shared/types'
import type { Prompter } from './prompts'
import type { Vault } from './vault'
import { closeConnection, connect, type Connection } from './ssh/connect'
import { writeFileAtomic } from './files'
import { POWERSHELL, findProgram, system32 } from './system'

const CLEANUP_MS = 30_000

// CredWriteW with the password read from stdin, so it never shows up in a process command line.
// Persist = session: Windows drops it at sign-out even if bawkterm never gets to delete it.
const CRED_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BawkCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, int flags);
  public static int Write(string target, string user, string secret) {
    var c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 1;
    c.CredentialBlobSize = secret.Length * 2;
    c.CredentialBlob = Marshal.StringToCoTaskMemUni(secret);
    try { return CredWrite(ref c, 0) ? 0 : Marshal.GetLastWin32Error(); }
    finally { Marshal.ZeroFreeCoTaskMemUnicode(c.CredentialBlob); }
  }
}
'@
  $secret = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))
  [Console]::Out.WriteLine([BawkCred]::Write($env:BAWK_TARGET, $env:BAWK_USER, $secret))
} catch {
  [Console]::Out.WriteLine('error')
}
`

export function writeCredential(target: string, user: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(CRED_SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, BAWK_TARGET: target, BAWK_USER: user }, windowsHide: true, timeout: 60_000 },
      (_err, stdout) => {
        const out = String(stdout).trim()
        if (out === '0') resolve()
        else reject(new Error(`Could not hand the password to Remote Desktop (${out || 'no answer'})`))
      }
    )
    child.stdin?.end(Buffer.from(password, 'utf8').toString('base64') + '\n')
  })
}

export function deleteCredential(target: string): void {
  try {
    execFileSync(system32('cmdkey.exe'), [`/delete:${target}`], { windowsHide: true, stdio: 'ignore' })
  } catch {
    // already gone
  }
}

const field = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, '')

export function rdpFile(address: string, username: string, fullscreen: boolean): string {
  return [
    `full address:s:${field(address)}`,
    username ? `username:s:${field(username)}` : '',
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

// each tunnel gets its own loopback address, so its TERMSRV credential can never be picked up by another launch
function loopbackAddress(): string {
  return `127.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}`
}

export async function tunnel(conn: Connection, host: string, port: number, bind = '127.0.0.1'): Promise<Server> {
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
    server.listen(0, bind, resolve)
  })
  return server
}

// on macOS the X11 client needs XQuartz, so the SDL client comes first
const FREERDP =
  process.platform === 'darwin'
    ? ['sdl-freerdp3', 'sdl-freerdp', 'xfreerdp3', 'xfreerdp']
    : ['xfreerdp3', 'sdl-freerdp3', 'wlfreerdp3', 'xfreerdp', 'sdl-freerdp', 'wlfreerdp']

// FreeRDP 3 is needed for /args-from; version 2 would need the password on its command line
async function freeRdp3(): Promise<string> {
  for (const name of FREERDP) {
    const bin = findProgram(name)
    if (!bin) continue
    const version = await new Promise<string>((resolve) =>
      execFile(bin, ['/version'], { timeout: 10_000 }, (_err, out) => resolve(String(out)))
    )
    if (/version 3\./i.test(version)) return bin
  }
  if (process.platform === 'darwin') throw new Error('Remote Desktop on macOS needs FreeRDP 3. Install it with: brew install freerdp')
  throw new Error('Remote Desktop on Linux needs FreeRDP 3 (xfreerdp3 or sdl-freerdp3). Install it from your package manager.')
}

// every argument, the password included, goes through stdin so none of it shows up in a process list
function startFreeRdp(bin: string, address: string, username: string, password: string, fullscreen: boolean, title: string): ChildProcess {
  const args = [
    `/v:${address}`,
    ...(username ? [`/u:${username}`] : []),
    ...(password ? [`/p:${password}`] : []),
    fullscreen ? '/f' : '/dynamic-resolution',
    '+clipboard',
    '/cert:tofu',
    `/title:${title}`
  ]
  if (args.some((a) => /[\r\n]/.test(a))) throw new Error('Remote Desktop settings cannot contain line breaks')
  const child = spawn(bin, ['/args-from:stdin'], { stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin?.end(args.join('\n') + '\n')
  return child
}

interface RdpTarget {
  hostId?: string
  label: string
  address: string
  port: number
  username: string
  password: string
  fullscreen: boolean
  jumpHostId: string
}

function resolveTarget(target: ConnectTarget, vault: Vault): RdpTarget {
  if ('adhoc' in target) {
    const { address, port, username } = target.adhoc
    return { label: address, address, port, username, password: '', fullscreen: false, jumpHostId: '' }
  }
  const data = vault.get()
  const host = data.hosts.find((h) => h.id === target.hostId)
  if (!host || host.kind !== 'rdp') throw new Error('RDP host not found')
  const identity = host.identityId ? data.identities.find((i) => i.id === host.identityId) : undefined
  return {
    hostId: host.id,
    label: host.label || host.address,
    address: host.address,
    port: host.port || 3389,
    username: host.username || identity?.username || '',
    password: host.password || identity?.password || '',
    fullscreen: host.rdpFullscreen,
    jumpHostId: host.jumpHostId
  }
}

const pendingFile = (): string => join(app.getPath('userData'), 'rdp-credentials.json')

// credentials from a run that crashed before its cleanup timer fired
export function sweepRdpCredentials(): void {
  const file = pendingFile()
  if (!existsSync(file)) return
  try {
    for (const target of JSON.parse(readFileSync(file, 'utf8')) as string[]) deleteCredential(target)
  } catch {
    // unreadable list, nothing to clean
  }
  rmSync(file, { force: true })
}

export class RdpLauncher {
  private pending = new Set<string>()

  constructor(
    private vault: Vault,
    private prompter: Prompter
  ) {}

  private async track(target: string, on: boolean): Promise<void> {
    if (on) this.pending.add(target)
    else this.pending.delete(target)
    await writeFileAtomic(pendingFile(), JSON.stringify([...this.pending])).catch(() => {})
  }

  dispose(): void {
    for (const target of this.pending) deleteCredential(target)
    this.pending.clear()
    rmSync(pendingFile(), { force: true })
  }

  private async touch(hostId: string | undefined): Promise<void> {
    if (!hostId) return
    await this.vault.mutate((d) => {
      const stored = d.hosts.find((h) => h.id === hostId)
      if (stored) stored.lastUsedAt = Date.now()
    })
  }

  async launch(connectTarget: ConnectTarget): Promise<void> {
    const windows = process.platform === 'win32'
    const freeRdp = windows ? '' : await freeRdp3()
    const host = resolveTarget(connectTarget, this.vault)
    const ask = this.prompter.forSession(`rdp:${randomUUID()}`)

    // mstsc asks for missing credentials itself, FreeRDP would ask on a terminal nobody sees
    if (!windows && !host.password) {
      const answer = await ask({
        kind: 'credentials',
        title: 'Remote Desktop',
        message: `Sign in to ${host.address}`,
        fields: [
          { name: 'username', label: 'Username', value: host.username },
          { name: 'password', label: 'Password', secret: true }
        ],
        confirmLabel: 'Connect'
      })
      if (!answer) return
      host.username = answer.values.username.trim()
      host.password = answer.values.password
    }
    const { username, password } = host

    let target = host.address
    let port = host.port
    let conn: Connection | undefined
    let server: Server | undefined
    let credential: string | undefined
    let file: string | undefined
    const cleanup = (): void => {
      server?.close()
      if (conn) closeConnection(conn)
    }
    try {
      if (host.jumpHostId) {
        conn = await connect({ hostId: host.jumpHostId }, {
          vault: this.vault,
          ask,
          signal: new AbortController().signal
        })
        target = loopbackAddress()
        server = await tunnel(conn, host.address, port, target)
        port = (server.address() as AddressInfo).port
      }
      const address = port === 3389 ? target : `${target}:${port}`

      if (!windows) {
        const child = startFreeRdp(freeRdp, address, username, password, host.fullscreen, host.label)
        child.once('error', cleanup)
        child.once('exit', cleanup)
        await this.touch(host.hostId)
        return
      }

      if (username && password) {
        credential = `TERMSRV/${target}`
        await this.track(credential, true)
        await writeCredential(credential, username, password)
      }

      const dir = join(tmpdir(), 'bawkterm-rdp')
      await fsp.mkdir(dir, { recursive: true })
      file = join(dir, `${randomUUID()}.rdp`)
      await fsp.writeFile(file, rdpFile(address, username, host.fullscreen), 'utf8')

      const child = spawn(system32('mstsc.exe'), [file], { stdio: 'ignore', windowsHide: false })
      child.once('error', cleanup)
      child.once('exit', cleanup)
    } catch (err) {
      cleanup()
      if (credential) {
        deleteCredential(credential)
        void this.track(credential, false)
      }
      if (file) void fsp.rm(file, { force: true })
      throw err
    }

    const launched = { credential, file }
    setTimeout(() => {
      if (launched.file) void fsp.rm(launched.file, { force: true })
      if (launched.credential) {
        deleteCredential(launched.credential)
        void this.track(launched.credential, false)
      }
    }, CLEANUP_MS)

    await this.touch(host.hostId)
  }
}
