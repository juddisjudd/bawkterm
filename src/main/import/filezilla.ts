import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Found, Scan } from './commit'
import { decodeText } from './text'

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const SFTP = '1'
const KEY_FILE_LOGON = '5'
const MAX_DEPTH = 64

export const sitemanagerPath = (): string =>
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'FileZilla', 'sitemanager.xml')
    : join(homedir(), '.config', 'filezilla', 'sitemanager.xml')

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10)) : (ENTITIES[e] ?? all)
  )

// enough XML for FileZilla's own files: elements, attributes, text and entities
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { tag: '', attrs: {}, children: [], text: '' }
  const stack = [root]
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  for (const m of xml.matchAll(token)) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.text += m[1]
    else if (m[6] !== undefined) top.text += unescapeXml(m[6])
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1 && top.tag === m[3]) stack.pop()
        continue
      }
      const attrs: Record<string, string> = {}
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescapeXml(a[2] ?? a[3])
      const node: XmlNode = { tag: m[3], attrs, children: [], text: '' }
      top.children.push(node)
      if (!m[5]) {
        if (stack.length > MAX_DEPTH) throw new Error('This file nests too deeply')
        stack.push(node)
      }
    }
  }
  return root
}

const child = (node: XmlNode, tag: string): XmlNode | undefined => node.children.find((c) => c.tag === tag)
const field = (node: XmlNode, tag: string): string => child(node, tag)?.text.trim() ?? ''

// FileZilla writes paths as "<type> <prefix length> [prefix] <length> <segment> ...", with Unix paths as type 1
export function remoteDir(encoded: string): string | null {
  let pos = 0
  const int = (): number | null => {
    const m = encoded.slice(pos).match(/^(\d+) ?/)
    if (!m) return null
    pos += m[0].length
    return Number(m[1])
  }
  const take = (n: number): string => {
    const s = encoded.slice(pos, pos + n)
    pos += n + 1
    return s
  }
  if (int() !== 1) return null
  const prefix = int()
  if (prefix === null) return null
  if (prefix) take(prefix)
  const parts: string[] = []
  while (pos < encoded.length) {
    const n = int()
    if (n === null) return null
    parts.push(take(n))
  }
  return '/' + parts.join('/')
}

export function filezillaSites(xml: string): Scan {
  const scan: Scan = { hosts: [], skipped: [] }
  const doc = parseXml(xml)
  const top = child(doc, 'FileZilla3')
  const servers = top && (child(top, 'Servers') ?? top)
  if (!servers) throw new Error('This is not a FileZilla site list')
  let protectedPasswords = false

  const walk = (node: XmlNode, folders: string[]): void => {
    for (const c of node.children) {
      if (c.tag === 'Folder') walk(c, [...folders, c.text.trim() || 'Folder'])
      if (c.tag !== 'Server') continue
      const name = field(c, 'Name') || field(c, 'Host')
      if (field(c, 'Protocol') !== SFTP) {
        scan.skipped.push(`${name}: only SFTP sites are imported`)
        continue
      }
      const pass = child(c, 'Pass')
      let password: string | undefined
      if (pass?.attrs.encoding === 'base64') password = Buffer.from(pass.text.trim(), 'base64').toString('utf8')
      else if (pass?.attrs.encoding === 'crypt') protectedPasswords = true
      else if (pass?.text) password = pass.text
      const dir = remoteDir(field(c, 'RemoteDir'))
      const found: Found = {
        label: name,
        address: field(c, 'Host'),
        port: Number(field(c, 'Port')) || 22,
        username: field(c, 'User'),
        password,
        group: folders.length ? folders.join(' / ') : 'FileZilla',
        notes: field(c, 'Comments'),
        keyFile: field(c, 'Logontype') === KEY_FILE_LOGON ? field(c, 'Keyfile') || undefined : undefined,
        bookmarks: dir && dir !== '/' ? [dir] : []
      }
      scan.hosts.push(found)
    }
  }
  walk(servers, [])
  if (protectedPasswords) scan.skipped.push('Some passwords are protected by your FileZilla master password, so they were not imported')
  return scan
}

export async function scanFilezilla(): Promise<Scan> {
  if (!existsSync(sitemanagerPath())) return { hosts: [], skipped: [] }
  return filezillaSites(decodeText(await fsp.readFile(sitemanagerPath())))
}
