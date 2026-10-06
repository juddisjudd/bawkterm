import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { system32 } from '../system'
import { decodeText } from './text'

export type RegValue = string | number
export type RegTree = Map<string, Map<string, RegValue>>

// reg.exe prints in the console code page, but its export files are UTF-16, so names outside ASCII survive
export async function readRegistry(key: string): Promise<RegTree> {
  if (process.platform !== 'win32') return new Map()
  const dir = await fsp.mkdtemp(join(tmpdir(), 'bawkterm-reg-'))
  const file = join(dir, 'export.reg')
  try {
    const exported = await new Promise<boolean>((resolve) => {
      execFile(system32('reg.exe'), ['export', key, file, '/y'], { windowsHide: true, timeout: 20_000 }, (err) => resolve(!err))
    })
    return exported ? parseRegFile(decodeText(await fsp.readFile(file)), key) : new Map()
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

const unquote = (s: string): string => s.replace(/\\(.)/g, '$1')

// keys are paths below the exported key, '' for the key itself
export function parseRegFile(text: string, root: string): RegTree {
  const tree: RegTree = new Map()
  const rootPath = root.replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').toLowerCase()
  let values: Map<string, RegValue> | undefined
  const lines = text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/)
  for (const line of lines) {
    const section = line.match(/^\[(.+)\]$/)
    if (section) {
      values = undefined
      if (section[1].toLowerCase().startsWith(rootPath)) {
        values = new Map()
        tree.set(section[1].slice(rootPath.length).replace(/^\\/, ''), values)
      }
      continue
    }
    const m = values && line.match(/^"((?:[^"\\]|\\.)*)"=(.*)$/)
    if (!m || !values) continue
    const [, name, raw] = m
    const str = raw.match(/^"((?:[^"\\]|\\.)*)"$/)
    const dword = raw.match(/^dword:([0-9a-fA-F]{8})$/)
    if (str) values.set(unquote(name), unquote(str[1]))
    else if (dword) values.set(unquote(name), parseInt(dword[1], 16))
  }
  return tree
}

export const regString = (v: RegValue | undefined): string => (typeof v === 'string' ? v : '')
export const regNumber = (v: RegValue | undefined): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined
