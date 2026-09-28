import type { SessionStatus } from '@shared/types'

const BACKOFF = [1, 2, 5, 10, 20, 30]
const MAX_ATTEMPTS = 30
const PERMANENT = /authentication|not trusted|cancel|not installed|cannot reach docker/i

export interface RetryState {
  attempt: number
  seconds: number
}

// Retries a dropped session with backoff; each tab view owns one.
export class Reconnector {
  state = $state<RetryState | null>(null)
  private timer: ReturnType<typeof setInterval> | undefined
  private last: SessionStatus | undefined
  private readonly onOnline = (): void => {
    if (this.state) this.now()
  }

  constructor(private connect: () => void) {
    window.addEventListener('online', this.onOnline)
  }

  // Feed every status change; returns true when a drop starts a retry.
  track(status: SessionStatus, dropped: boolean | undefined, message: string | undefined, enabled: boolean): boolean {
    const previous = this.last
    if (status === previous) return false
    this.last = status
    if (status === 'connected') {
      this.stop()
    } else if (previous === 'connected' && status === 'closed' && dropped && enabled) {
      this.schedule(1)
      return true
    } else if (status === 'error' && this.state) {
      if (PERMANENT.test(message ?? '')) this.stop()
      else this.schedule(this.state.attempt + 1)
    } else if (status === 'closed' && this.state && previous === 'connecting') {
      this.stop()
    }
    return false
  }

  now(): void {
    this.stop()
    this.connect()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.state = null
  }

  dispose(): void {
    this.stop()
    window.removeEventListener('online', this.onOnline)
  }

  private schedule(attempt: number): void {
    clearInterval(this.timer)
    if (attempt > MAX_ATTEMPTS) {
      this.state = null
      return
    }
    this.state = { attempt, seconds: BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)] }
    this.timer = setInterval(() => {
      if (!this.state) return
      if (this.state.seconds <= 1) {
        clearInterval(this.timer)
        this.connect()
      } else {
        this.state.seconds--
      }
    }, 1000)
  }
}
