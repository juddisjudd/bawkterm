import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const root = process.env.SystemRoot || 'C:\\Windows'
const windows = process.platform === 'win32'

// system tools by full path so a same-named program in the working directory is never picked up
export const system32 = (exe: string): string => join(root, 'System32', exe)
export const POWERSHELL = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function splitCommand(command: string): string[] {
  const parts: string[] = []
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) parts.push(m[1] ?? m[2])
  return parts
}

function runnable(path: string): boolean {
  if (!existsSync(path)) return false
  if (windows) return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// apps started from Finder get a PATH without Homebrew
const MAC_EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin']

// PATH lookup that skips the current directory, which Windows would otherwise search first
export function findProgram(name: string): string | null {
  if (isAbsolute(name)) return runnable(name) ? name : null
  if (/[\\/]/.test(name)) return null
  const exts = windows && !/\.\w+$/.test(name) ? ['.exe', '.cmd', '.bat', '.com'] : ['']
  const dirs = (process.env.PATH ?? '').split(delimiter)
  if (process.platform === 'darwin') dirs.push(...MAC_EXTRA_PATH)
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (runnable(candidate)) return candidate
    }
  }
  return null
}
