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
