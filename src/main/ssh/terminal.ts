import type { ClientChannel } from 'ssh2'
import type { ConnectTarget, SessionEvent } from '@shared/types'
import type { Prompter, Send } from '../prompts'
import type { Vault } from '../vault'
import { CancelledError, closeConnection, connect, type Connection } from './connect'

const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024

interface Session {
  id: string
  abort: AbortController
  conn?: Connection
  stream?: ClientChannel
  unacked: number
  paused: boolean
  queue: Buffer[]
  flushScheduled: boolean
  closed: boolean
  exited: boolean
  userClosed: boolean
}

export class Terminals {
  private sessions = new Map<string, Session>()

  constructor(
    private vault: Vault,
    private prompter: Prompter,
    private send: Send
  ) {}

  private status(sessionId: string, status: SessionEvent['status'], message?: string, dropped?: boolean): void {
    const event: SessionEvent = { sessionId, status, message, dropped }
    this.send('ssh:status', event)
  }

  async open(sessionId: string, target: ConnectTarget, cols: number, rows: number, command?: string): Promise<void> {
    this.close(sessionId)
    const session: Session = {
      id: sessionId,
      abort: new AbortController(),
      unacked: 0,
      paused: false,
      queue: [],
      flushScheduled: false,
      closed: false,
      exited: false,
      userClosed: false
    }
    this.sessions.set(sessionId, session)
    this.status(sessionId, 'connecting')

    try {
      session.conn = await connect(target, {
        vault: this.vault,
        ask: this.prompter.forSession(sessionId),
        signal: session.abort.signal,
        onProgress: (message) => this.status(sessionId, 'connecting', message)
      })
      const pty = { term: 'xterm-256color', cols, rows }
      session.stream = await new Promise<ClientChannel>((resolve, reject) => {
        const done = (err: Error | undefined, stream: ClientChannel): void => (err ? reject(err) : resolve(stream))
        if (command) session.conn!.client.exec(command, { pty }, done)
        else session.conn!.client.shell(pty, done)
      })
    } catch (err) {
      if (session.conn) closeConnection(session.conn)
      this.sessions.delete(sessionId)
      if (err instanceof CancelledError) {
        this.status(sessionId, 'closed', 'Cancelled')
        return
      }
      this.status(sessionId, 'error', (err as Error).message)
      throw err
    }

    if (session.closed) {
      closeConnection(session.conn)
      return
    }

    const { stream, conn } = session
    const onData = (chunk: Buffer): void => this.push(session, chunk)
    stream.on('data', onData)
    stream.stderr.on('data', onData)
    stream.on('exit', () => (session.exited = true))
    stream.on('close', () => this.finish(session, command ? 'Command finished' : 'Session ended'))
    conn.client.on('close', () => this.finish(session, 'Connection closed'))
    conn.client.on('error', (err) => this.finish(session, err.message))
    this.status(sessionId, 'connected')

    const startup = !command && 'hostId' in target ? this.vault.get().hosts.find((h) => h.id === target.hostId)?.startupCommand : ''
    if (startup?.trim()) stream.write(startup.trim().replace(/\r?\n/g, '\r') + '\r')
  }

  private push(session: Session, chunk: Buffer): void {
    session.queue.push(chunk)
    session.unacked += chunk.length
    if (!session.paused && session.unacked > HIGH_WATER) {
      session.paused = true
      session.stream?.pause()
    }
    if (session.flushScheduled) return
    session.flushScheduled = true
    setImmediate(() => {
      session.flushScheduled = false
      if (!session.queue.length) return
      const data = session.queue.length === 1 ? session.queue[0] : Buffer.concat(session.queue)
      session.queue = []
      this.send('ssh:data', session.id, new Uint8Array(data))
    })
  }

  private finish(session: Session, message: string): void {
    if (session.closed) return
    session.closed = true
    this.sessions.delete(session.id)
    if (session.conn) closeConnection(session.conn)
    const dropped = !session.exited && !session.userClosed
    this.status(session.id, 'closed', dropped && message === 'Session ended' ? 'Connection lost' : message, dropped)
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.stream?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const stream = this.sessions.get(sessionId)?.stream
    if (stream && cols > 0 && rows > 0) stream.setWindow(rows, cols, 0, 0)
  }

  ack(sessionId: string, bytes: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.unacked = Math.max(0, session.unacked - bytes)
    if (session.paused && session.unacked < LOW_WATER) {
      session.paused = false
      session.stream?.resume()
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.userClosed = true
    this.prompter.cancelSession(sessionId)
    session.abort.abort()
    this.finish(session, 'Closed')
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
