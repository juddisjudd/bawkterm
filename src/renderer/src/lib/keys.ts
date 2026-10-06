import type { Direction } from './panes'

export const isMac = window.api.platform === 'darwin'

export const MOD = isMac ? 'Cmd' : 'Ctrl'

export function mod(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

// Ctrl+Shift+key where Ctrl+key belongs to the shell; macOS leaves Cmd+key free, so Shift is optional there
export function shellSafe(e: KeyboardEvent, key: string): boolean {
  return mod(e) && (isMac || e.shiftKey) && e.key.toLowerCase() === key
}

export const shellSafeLabel = (key: string): string => (isMac ? `Cmd+${key}` : `Ctrl+Shift+${key}`)

// iTerm2's keys on macOS; elsewhere Ctrl+D belongs to the shell
export function splitKey(e: KeyboardEvent): 'row' | 'column' | null {
  if (!mod(e) || e.altKey) return null
  const key = e.key.toLowerCase()
  if (isMac) return key === 'd' ? (e.shiftKey ? 'column' : 'row') : null
  if (!e.shiftKey) return null
  return key === 'd' ? 'row' : key === 'e' ? 'column' : null
}

export const SPLIT_KEYS = isMac ? { row: 'Cmd+D', column: 'Cmd+Shift+D' } : { row: 'Ctrl+Shift+D', column: 'Ctrl+Shift+E' }

export const PANE_ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}
