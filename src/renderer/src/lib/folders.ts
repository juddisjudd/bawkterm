import type { FolderColor, Host } from '@shared/types'

export interface FolderMarks {
  favorites: string[]
  colors: Record<string, FolderColor>
  setFavorite: (path: string, on: boolean) => void
  setColor: (paths: string[], color: FolderColor | null) => void
}

type Marks = Pick<Host, 'bookmarks' | 'folderColors'>

export const tint = (color: FolderColor | undefined): string | undefined => (color ? `var(--folder-${color})` : undefined)

const inside = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

// moves favorites and colors along with a renamed folder, or drops them when `to` is null
export function remapFolders(marks: Marks, from: string, to: string | null): Marks | null {
  const move = (p: string): string | null => (inside(p, from) ? (to === null ? null : to + p.slice(from.length)) : p)
  let changed = false
  const bookmarks: string[] = []
  for (const b of marks.bookmarks) {
    const next = move(b)
    if (next !== b) changed = true
    if (next !== null && !bookmarks.includes(next)) bookmarks.push(next)
  }
  const folderColors: Record<string, FolderColor> = {}
  for (const [p, c] of Object.entries(marks.folderColors)) {
    const next = move(p)
    if (next !== p) changed = true
    if (next !== null) folderColors[next] = c
  }
  return changed ? { bookmarks, folderColors } : null
}

// last path segment, or the last two when two favorites share a name
export function favoriteLabels(paths: string[]): Map<string, string> {
  const segments = (p: string): string[] => p.split('/').filter(Boolean)
  const short = (p: string): string => segments(p).at(-1) ?? '/'
  const counts = new Map<string, number>()
  for (const p of paths) counts.set(short(p), (counts.get(short(p)) ?? 0) + 1)
  return new Map(
    paths.map((p) => [p, (counts.get(short(p)) ?? 0) > 1 ? segments(p).slice(-2).join('/') || '/' : short(p)])
  )
}
