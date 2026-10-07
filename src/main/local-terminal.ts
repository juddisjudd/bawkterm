import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { IPty } from 'node-pty'
import type { LocalShell, SessionEvent } from '@shared/types'
import type { Send } from './prompts'
import type { SessionLogs } from './session-log'
import { findProgram, POWERSHELL, system32 } from './system'

const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024
const EXIT_WAIT_MS = 3000
// Docker Desktop's own distros are not shells anyone means to open
const WSL_INTERNAL = /^docker-desktop(-data)?$/i
const mac = process.platform === 'darwin'

interface Shell extends LocalShell {
  file: string
  args: string[]
}

interface Session {
  id: string
  pty: IPty
  unacked: number
  paused: boolean
  queue: Buffer[]
  flushScheduled: boolean
  closed: boolean
}

function wslDistros(): Promise<string[]> {
  const wsl = system32('wsl.exe')
  if (!existsSync(wsl)) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(wsl, ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve([])
      const names = out.toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/)
      resolve(names.map((n) => n.replace(/\0/g, '').trim()).filter((n) => n && !WSL_INTERNAL.test(n)))
    })
  })
}

async function detect(): Promise<Shell[]> {
  if (process.platform === 'win32') {
    const shells: Shell[] = []
    const pwsh = findProgram('pwsh')
    if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell', file: pwsh, args: ['-NoLogo'] })
    shells.push({ id: 'powershell', name: 'Windows PowerShell', file: POWERSHELL, args: ['-NoLogo'] })
    shells.push({ id: 'cmd', name: 'Command Prompt', file: system32('cmd.exe'), args: [] })
    for (const distro of await wslDistros()) {
      shells.push({ id: `wsl:${distro}`, name: `${distro} (WSL)`, file: system32('wsl.exe'), args: ['-d', distro, '--cd', '~'] })
    }
    const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    if (existsSync(gitBash)) shells.push({ id: 'git-bash', name: 'Git Bash', file: gitBash, args: ['-i', '-l'] })
    return shells
  }

  // a Flatpak build runs its shells inside the sandbox, so say so where the shell is picked
  const where = process.env.FLATPAK_ID ? ' (sandbox)' : ''
  // macOS terminals start login shells, which is what loads Homebrew and the user's profile
  const args = mac ? ['-l'] : []
  const shells: Shell[] = []
  const seen = new Set<string>()
  const add = (file: string, id: string): void => {
    const name = basename(file)
    if (seen.has(name) || !existsSync(file)) return
    seen.add(name)
    shells.push({ id, name: name + where, file, args })
  }
  if (process.env.SHELL) add(process.env.SHELL, 'default')
  let listed: string[] = []
  try {
    listed = readFileSync('/etc/shells', 'utf8').split('\n')
  } catch {
    // no /etc/shells: only the login shell and /bin/sh are offered
  }
  for (const line of listed) {
    const file = line.trim()
    if (file.startsWith('/') && !/(nologin|false)$/.test(file)) add(file, file)
  }
  if (!shells.length) add('/bin/sh', '/bin/sh')
  return shells
}

// the app's own variables stay out of the shell; the rest is the user's environment as the app received it
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('ELECTRON_') && key !== 'BAWKTERM_DATA_DIR' && key !== 'NODE_OPTIONS') env[key] = value
  }
  if (process.platform !== 'win32') env.TERM = 'xterm-256color'
  if (mac && !env.LANG) env.LANG = 'en_US.UTF-8'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'bawkterm'
  return env
}

export class LocalTerminals {
  private sessions = new Map<string, Session>()
  private running = new Set<Promise<void>>()
  private detected?: Promise<Shell[]>

  constructor(
    private send: Send,
    private logs: SessionLogs
  ) {}

  private shells(): Promise<Shell[]> {
    this.detected ??= detect().catch((err) => {
      this.detected = undefined
      throw err
    })
    return this.detected
  }

  async list(): Promise<LocalShell[]> {
    return (await this.shells()).map(({ id, name }) => ({ id, name }))
  }

  private status(sessionId: string, status: SessionEvent['status'], message?: string): void {
    const event: SessionEvent = { sessionId, status, message }
    this.send('pty:status', event)
  }

  async open(sessionId: string, shellId: string, cols: number, rows: number): Promise<void> {
    this.close(sessionId)
    const shell = (await this.shells()).find((s) => s.id === shellId)
    if (!shell) {
      this.status(sessionId, 'error', 'That shell is not available on this computer')
      throw new Error('That shell is not available on this computer')
    }
    this.status(sessionId, 'connecting')
    let pty: IPty
    try {
      // loaded on first use, so a broken native module only breaks local terminals, never the app's start
      const { spawn } = await import('node-pty')
      pty = spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: homedir(), env: shellEnv() })
    } catch (err) {
      const message = `Could not start ${shell.name}: ${(err as Error).message}`
      this.status(sessionId, 'error', message)
      throw new Error(message)
    }
    const session: Session = { id: sessionId, pty, unacked: 0, paused: false, queue: [], flushScheduled: false, closed: false }
    this.sessions.set(sessionId, session)
    pty.onData((data) => this.push(session, Buffer.from(data, 'utf8')))
    const exited = new Promise<void>((resolve) =>
      pty.onExit(({ exitCode }) => {
        this.finish(session, exitCode ? `${shell.name} exited with code ${exitCode}` : `${shell.name} exited`)
        resolve()
      })
    )
    this.running.add(exited)
    void exited.then(() => this.running.delete(exited))
    this.status(sessionId, 'connected')
    this.logs.open(sessionId, `${shell.name} (local)`)
  }

  private push(session: Session, chunk: Buffer): void {
    this.logs.write(session.id, chunk)
    session.queue.push(chunk)
    session.unacked += chunk.length
    if (!session.paused && session.unacked > HIGH_WATER) {
      session.paused = true
      session.pty.pause()
    }
    if (session.flushScheduled) return
    session.flushScheduled = true
    setImmediate(() => {
      session.flushScheduled = false
      if (!session.queue.length) return
      const data = session.queue.length === 1 ? session.queue[0] : Buffer.concat(session.queue)
      session.queue = []
      this.send('pty:data', session.id, new Uint8Array(data))
    })
  }

  private finish(session: Session, message: string): void {
    if (session.closed) return
    session.closed = true
    this.logs.close(session.id)
    this.sessions.delete(session.id)
    this.status(session.id, 'closed', message)
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session && cols > 0 && rows > 0) session.pty.resize(cols, rows)
  }

  ack(sessionId: string, bytes: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.unacked = Math.max(0, session.unacked - bytes)
    if (session.paused && session.unacked < LOW_WATER) {
      session.paused = false
      session.pty.resume()
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.finish(session, 'Closed')
    try {
      session.pty.kill()
    } catch {
      // the shell already exited
    }
  }

  get busy(): boolean {
    return this.running.size > 0
  }

  // node-pty reports an exit from a native thread, which crashes the process if it lands after quitting has begun
  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.close(id)
    await Promise.race([Promise.all(this.running), new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS))])
    this.running.clear()
  }
}
