import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import type { Vault } from './vault'

type Mode = 'text' | 'esc' | 'csi' | 'string' | 'stringEsc' | 'charset'

// readable text from terminal output: escape sequences and control characters, \r included, are dropped
export class PlainText {
  private decoder = new TextDecoder('utf-8')
  private mode: Mode = 'text'

  push(chunk: Uint8Array): string {
    let out = ''
    for (const ch of this.decoder.decode(chunk, { stream: true })) {
      const code = ch.codePointAt(0)!
      switch (this.mode) {
        case 'text':
          if (code === 0x1b) this.mode = 'esc'
          else if (code === 0x0a || code === 0x09 || (code >= 0x20 && code < 0x7f) || code >= 0xa0) out += ch
          break
        case 'esc':
          if (ch === '[') this.mode = 'csi'
          else if (ch === ']' || ch === 'P' || ch === '^' || ch === '_' || ch === 'X') this.mode = 'string'
          else if ('()*+-./#%'.includes(ch)) this.mode = 'charset'
          else this.mode = 'text'
          break
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) this.mode = 'text'
          break
        case 'charset':
          this.mode = 'text'
          break
        case 'string':
          if (code === 0x07) this.mode = 'text'
          else if (code === 0x1b) this.mode = 'stringEsc'
          break
        case 'stringEsc':
          this.mode = ch === '\\' ? 'text' : 'string'
          break
      }
    }
    return out
  }
}

interface Log {
  stream: WriteStream
  text: PlainText
}

const UNSAFE = /[\\/:*?"<>|\x00-\x1f]+/g

export function logFolder(vault: Vault): string {
  const chosen = vault.get().settings.sessionLogFolder
  if (chosen && isAbsolute(chosen)) return chosen
  try {
    return join(app.getPath('documents'), 'bawkterm logs')
  } catch {
    return join(homedir(), 'bawkterm logs')
  }
}

function stamp(d: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`
}

export class SessionLogs {
  private logs = new Map<string, Log>()

  constructor(private vault: Vault) {}

  // a log that cannot be written never stops the session itself
  open(sessionId: string, name: string): void {
    this.close(sessionId)
    if (!this.vault.unlocked || !this.vault.get().settings.sessionLogs) return
    try {
      const folder = logFolder(this.vault)
      mkdirSync(folder, { recursive: true })
      const started = new Date()
      const file = join(folder, `${name.replace(UNSAFE, '_').slice(0, 80) || 'session'} ${stamp(started)}.log`)
      const stream = createWriteStream(file, { flags: 'a', mode: 0o600 })
      stream.on('error', () => this.logs.delete(sessionId))
      stream.write(`--- ${name}, ${started.toLocaleString()} ---\n`)
      this.logs.set(sessionId, { stream, text: new PlainText() })
    } catch {
      this.logs.delete(sessionId)
    }
  }

  write(sessionId: string, chunk: Uint8Array): void {
    const log = this.logs.get(sessionId)
    if (!log) return
    const text = log.text.push(chunk)
    if (text) log.stream.write(text)
  }

  close(sessionId: string): void {
    const log = this.logs.get(sessionId)
    if (!log) return
    this.logs.delete(sessionId)
    log.stream.end(`\n--- ended ${new Date().toLocaleString()} ---\n`)
  }
}
