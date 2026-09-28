const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${UNITS[i]}`
}

export function date(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ago(ms?: number): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function bar(fraction: number, width = 16): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']'
}

export function mode(m: number): string {
  const chars = 'rwxrwxrwx'
  let out = ''
  for (let i = 0; i < 9; i++) out += m & (1 << (8 - i)) ? chars[i] : '-'
  return out
}
