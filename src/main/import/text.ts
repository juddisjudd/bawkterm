import { homedir } from 'node:os'
import { resolve } from 'node:path'

// files from older Windows tools are Windows-1252 unless they carry a BOM or happen to be valid UTF-8
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('windows-1252').decode(buf)
  }
}

// PuTTY and WinSCP store names and paths with %XX escapes
export function unescapePercent(s: string): string {
  if (!s.includes('%')) return s
  const bytes: number[] = []
  for (let i = 0; i < s.length; ) {
    const hex = s.slice(i + 1, i + 3)
    if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 3
    } else {
      const ch = String.fromCodePoint(s.codePointAt(i)!)
      bytes.push(...Buffer.from(ch, 'utf8'))
      i += ch.length
    }
  }
  return decodeText(Buffer.from(bytes))
}

export const expandHome = (path: string): string => resolve(path.replace(/^~(?=$|[\\/])/, homedir()))

export interface IniSection {
  name: string
  values: Map<string, string>
}

export function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const header = line.match(/^\[(.*)\]$/)
    if (header) {
      current = { name: header[1], values: new Map() }
      sections.push(current)
      continue
    }
    const eq = line.indexOf('=')
    if (current && eq > 0) current.values.set(line.slice(0, eq).trim(), line.slice(eq + 1))
  }
  return sections
}
