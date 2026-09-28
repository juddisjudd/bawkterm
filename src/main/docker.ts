import type { Client } from 'ssh2'
import type { ConnectTarget, ContainerInfo, ContainerStats, DockerAction, DockerCommand, SessionEvent } from '@shared/types'
import type { Prompter, Send } from './prompts'
import type { Vault } from './vault'
import { CancelledError, closeConnection, connect, type Connection } from './ssh/connect'

interface Session {
  abort: AbortController
  conn?: Connection
  docker: string
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

const CONTAINER_ID = /^[a-f0-9]{12,64}$/
const EXEC_TIMEOUT = 30_000

function exec(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        stream.close()
        reject(new Error('The server took too long to answer'))
      }, EXEC_TIMEOUT)
      stream.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      let code = 0
      stream.on('exit', (exitCode: number | null) => (code = exitCode ?? 0))
      stream.on('close', () => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  })
}

function jsonLines<T>(text: string): T[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as T)
}

function label(labels: string, key: string): string {
  const match = labels.split(',').find((pair) => pair.startsWith(`${key}=`))
  return match ? match.slice(key.length + 1) : ''
}

export class DockerSessions {
  private sessions = new Map<string, Session>()

  constructor(
    private vault: Vault,
    private prompter: Prompter,
    private send: Send
  ) {}

  private status(sessionId: string, status: SessionEvent['status'], message?: string, dropped?: boolean): void {
    this.send('docker:status', { sessionId, status, message, dropped } satisfies SessionEvent)
  }

  private session(sessionId: string): Session & { conn: Connection } {
    const session = this.sessions.get(sessionId)
    if (!session?.conn) throw new Error('Docker session is not connected')
    return session as Session & { conn: Connection }
  }

  async open(sessionId: string, target: ConnectTarget): Promise<{ title: string; version: string }> {
    this.close(sessionId)
    const session: Session = { abort: new AbortController(), docker: 'docker' }
    this.sessions.set(sessionId, session)
    this.status(sessionId, 'connecting')
    try {
      session.conn = await connect(target, {
        vault: this.vault,
        ask: this.prompter.forSession(sessionId),
        signal: session.abort.signal,
        onProgress: (message) => this.status(sessionId, 'connecting', message)
      })
      const version = await this.detect(session.conn.client, session)
      session.conn.client.on('close', () => {
        if (this.sessions.get(sessionId) === session) {
          this.sessions.delete(sessionId)
          this.status(sessionId, 'closed', 'Connection lost', true)
        }
      })
      this.status(sessionId, 'connected')
      return { title: session.conn.label, version }
    } catch (err) {
      if (session.conn) closeConnection(session.conn)
      this.sessions.delete(sessionId)
      const message = err instanceof CancelledError ? 'Cancelled' : (err as Error).message
      this.status(sessionId, err instanceof CancelledError ? 'closed' : 'error', message)
      throw new Error(message)
    }
  }

  private async detect(client: Client, session: Session): Promise<string> {
    const probe = "version --format '{{.Server.Version}}'"
    const direct = await exec(client, `docker ${probe}`)
    if (direct.code === 0) return direct.stdout.trim()
    if (/not found|No such file/i.test(direct.stderr)) throw new Error('Docker is not installed on this host')
    const viaSudo = await exec(client, `sudo -n docker ${probe}`)
    if (viaSudo.code === 0) {
      session.docker = 'sudo -n docker'
      return viaSudo.stdout.trim()
    }
    if (/permission denied/i.test(direct.stderr)) {
      throw new Error('This user cannot reach Docker. Add it to the docker group, or allow passwordless sudo for docker.')
    }
    throw new Error(direct.stderr.trim() || 'Docker did not respond')
  }

  async list(sessionId: string): Promise<ContainerInfo[]> {
    const { conn, docker } = this.session(sessionId)
    const res = await exec(conn.client, `${docker} ps -a --no-trunc --format '{{json .}}'`)
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'docker ps failed')
    return jsonLines<Record<string, string>>(res.stdout).map((c) => ({
      id: c.ID,
      name: (c.Names ?? '').split(',')[0],
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: c.Ports ?? '',
      project: label(c.Labels ?? '', 'com.docker.compose.project'),
      service: label(c.Labels ?? '', 'com.docker.compose.service')
    }))
  }

  async stats(sessionId: string): Promise<ContainerStats[]> {
    const { conn, docker } = this.session(sessionId)
    const res = await exec(conn.client, `${docker} stats --no-stream --no-trunc --format '{{json .}}'`)
    if (res.code !== 0) return []
    return jsonLines<Record<string, string>>(res.stdout).map((s) => ({ id: s.ID, cpu: s.CPUPerc, mem: s.MemUsage }))
  }

  async action(sessionId: string, containerId: string, action: DockerAction): Promise<void> {
    if (!CONTAINER_ID.test(containerId)) throw new Error('Invalid container id')
    const { conn, docker } = this.session(sessionId)
    const res = await exec(conn.client, `${docker} ${action} ${containerId}`)
    if (res.code !== 0) throw new Error(res.stderr.trim() || `docker ${action} failed`)
  }

  command(sessionId: string, containerId: string, kind: DockerCommand): string {
    if (!CONTAINER_ID.test(containerId)) throw new Error('Invalid container id')
    const { docker } = this.session(sessionId)
    return kind === 'logs'
      ? `${docker} logs -f --tail 500 ${containerId}`
      : `${docker} exec -it -e TERM=xterm-256color ${containerId} sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'`
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.prompter.cancelSession(sessionId)
    session.abort.abort()
    if (session.conn) closeConnection(session.conn)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
