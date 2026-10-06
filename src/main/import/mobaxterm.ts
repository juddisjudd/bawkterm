import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Found, Scan } from './commit'
import { decodeText, parseIni } from './text'

const SSH = '109'
const SFTP = '140'
const RDP = '91'

// field positions in an SSH session's first %-separated group
const HOST = 1
const PORT = 2
const USER = 3
const GATEWAY_HOSTS = 8
const GATEWAY_PORTS = 9
const GATEWAY_USERS = 10
const KEY = 14
const GATEWAY_KEYS = 15

export const mobaxtermIni = (): string => join(process.env.APPDATA ?? '', 'MobaXterm', 'MobaXterm.ini')

export const looksLikeMobaxterm = (text: string): boolean => /^\[Bookmarks(_\d+)?\]/m.test(text)

const ESCAPES: Record<string, string> = {
  __PTVIRG__: ';',
  __DBLQUO__: '"',
  __PIPE__: '|',
  __PERCENT__: '%',
  __DIEZE__: '#'
}

const unescape = (s: string): string => s.replace(/__(PTVIRG|DBLQUO|PIPE|PERCENT|DIEZE)__/g, (e) => ESCAPES[e])

const list = (s: string | undefined): string[] => (s ? s.split('__PIPE__').map(unescape) : [])

function keyPath(raw: string | undefined): string | undefined {
  const path = list(raw)[0]?.trim()
  if (!path) return undefined
  const drive = (process.env.SystemDrive ?? 'C:').replace(/:$/, '')
  return path.replace(/_CurrentDrive_/g, drive).replace(/_ProfileDir_/g, homedir())
}

export function mobaxtermSessions(text: string): Scan {
  const scan: Scan = { hosts: [], skipped: [] }
  for (const section of parseIni(text)) {
    if (!/^Bookmarks(_\d+)?$/.test(section.name)) continue
    const folder = section.values.get('SubRep')?.trim() ?? ''
    const group = folder ? folder.split('\\').filter(Boolean).join(' / ') : 'MobaXterm'
    for (const [name, value] of section.values) {
      if (name === 'SubRep' || name === 'ImgNum') continue
      const parts = value.trim().split('#')
      const type = parts[1]
      if (type === RDP) {
        scan.skipped.push(`${name}: RDP sessions are not imported`)
        continue
      }
      if (type !== SSH && type !== SFTP) {
        scan.skipped.push(`${name}: only SSH and SFTP sessions are imported`)
        continue
      }
      const f = (parts[2] ?? '').split('%')
      const address = unescape(f[HOST] ?? '').trim()
      if (!address) continue
      const user = unescape(f[USER] ?? '')
      const found: Found = {
        label: name,
        address,
        port: Number(f[PORT]) || 22,
        username: user === '<default>' ? '' : user,
        group,
        notes: unescape(parts[5] ?? '').trim(),
        keyFile: type === SSH ? keyPath(f[KEY]) : undefined
      }
      const gateway = list(f[GATEWAY_HOSTS])[0]?.trim()
      if (type === SSH && gateway) {
        found.jump = {
          address: gateway,
          port: Number(list(f[GATEWAY_PORTS])[0]) || 22,
          username: list(f[GATEWAY_USERS])[0] ?? '',
          keyFile: keyPath(f[GATEWAY_KEYS])
        }
      }
      scan.hosts.push(found)
    }
  }
  return scan
}

export async function scanMobaxterm(): Promise<Scan> {
  if (!existsSync(mobaxtermIni())) return { hosts: [], skipped: [] }
  return mobaxtermSessions(decodeText(await fsp.readFile(mobaxtermIni())))
}
