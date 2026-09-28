type DataHandler = (data: Uint8Array) => void

export interface TerminalHandle {
  paste(text: string): void
  run(text: string): void
}

const handlers = new Map<string, DataHandler>()
const terminals = new Map<string, TerminalHandle>()

window.api.ssh.onData((sessionId, data) => handlers.get(sessionId)?.(data))

export function onSessionData(sessionId: string, handler: DataHandler): () => void {
  handlers.set(sessionId, handler)
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId)
  }
}

export function registerTerminal(sessionId: string, handle: TerminalHandle): () => void {
  terminals.set(sessionId, handle)
  return () => {
    if (terminals.get(sessionId) === handle) terminals.delete(sessionId)
  }
}

export function terminalFor(sessionId: string): TerminalHandle | undefined {
  return terminals.get(sessionId)
}
