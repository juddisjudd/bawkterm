import { randomUUID } from 'node:crypto'
import type { PromptRequest, PromptResponse } from '@shared/types'
import type { Ask } from './ssh/connect'

export type Send = (channel: string, ...args: unknown[]) => void

interface Pending {
  sessionId: string
  resolve: (res: PromptResponse | null) => void
}

export class Prompter {
  private pending = new Map<string, Pending>()

  constructor(private send: Send) {}

  forSession(sessionId: string): Ask {
    return (req) =>
      new Promise((resolve) => {
        const id = randomUUID()
        this.pending.set(id, { sessionId, resolve })
        const full: PromptRequest = { ...req, id, sessionId }
        this.send('prompt:request', full)
      })
  }

  respond(id: string, res: PromptResponse | null): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.resolve(res)
  }

  cancelSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue
      this.pending.delete(id)
      p.resolve(null)
      this.send('prompt:cancel', id)
    }
  }

  cancelAll(): void {
    for (const [id, p] of this.pending) {
      p.resolve(null)
      this.send('prompt:cancel', id)
    }
    this.pending.clear()
  }
}
