import type { Host } from '@shared/types'
import type { Found, Scan } from './commit'

type Column = 'label' | 'address' | 'port' | 'username' | 'password' | 'group' | 'tags' | 'notes'

const HEADERS: Record<string, Column> = {
  label: 'label',
  name: 'label',
  alias: 'label',
  title: 'label',
  host: 'address',
  hostname: 'address',
  'hostname/ip': 'address',
  address: 'address',
  ip: 'address',
  server: 'address',
  port: 'port',
  user: 'username',
  username: 'username',
  login: 'username',
  password: 'password',
  group: 'group',
  groups: 'group',
  folder: 'group',
  tags: 'tags',
  notes: 'notes',
  note: 'notes',
  comment: 'notes',
  comments: 'notes',
  description: 'notes'
}

export const CSV_COLUMNS = ['label', 'host', 'port', 'username', 'group', 'tags', 'notes'] as const

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  // spreadsheets in many European locales save CSV with semicolons
  const first = text.split(/\r?\n/, 1)[0]
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ','
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((c) => c.trim())) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

export function csvHosts(text: string): Scan {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''))
  if (!header) throw new Error('This CSV file is empty')
  const columns = header.map((h) => HEADERS[h.trim().toLowerCase()])
  if (!columns.includes('address')) throw new Error('This CSV file needs a "host" column')
  const scan: Scan = { hosts: [], skipped: [] }
  rows.forEach((cells, i) => {
    const get = (c: Column): string => {
      const at = columns.indexOf(c)
      return at >= 0 ? (cells[at] ?? '').trim() : ''
    }
    const address = get('address')
    if (!address) {
      scan.skipped.push(`row ${i + 2}: no host`)
      return
    }
    const port = get('port') ? Number(get('port')) : 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      scan.skipped.push(`row ${i + 2}: port "${get('port')}" is not valid`)
      return
    }
    const found: Found = {
      label: get('label') || address,
      address,
      port,
      username: get('username'),
      password: get('password') || undefined,
      group: get('group'),
      notes: get('notes'),
      tags: get('tags')
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean)
    }
    scan.hosts.push(found)
  })
  return scan
}

const cell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function hostsToCsv(hosts: Host[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const h of hosts) {
    if (h.kind !== 'ssh') continue
    lines.push([h.label, h.address, String(h.port), h.username, h.group, h.tags.join(', '), h.notes].map(cell).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}
