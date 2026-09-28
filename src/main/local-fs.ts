import { shell } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FileEntry } from '@shared/types'

function windowsDrives(): FileEntry[] {
  const drives: FileEntry[] = []
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`
    if (existsSync(root)) {
      drives.push({ name: root, path: root, kind: 'dir', linkDir: false, size: 0, mtime: 0, mode: 0 })
    }
  }
  return drives
}

export const localFs = {
  home: (): string => homedir(),

  async list(dir: string): Promise<FileEntry[]> {
    if (!dir && process.platform === 'win32') return windowsDrives()
    const target = dir || '/'
    const dirents = await fsp.readdir(target, { withFileTypes: true })
    const entries = await Promise.all(
      dirents.map(async (d): Promise<FileEntry | null> => {
        const path = join(target, d.name)
        try {
          const st = await fsp.lstat(path)
          const link = st.isSymbolicLink()
          const linkDir = link ? await fsp.stat(path).then((s) => s.isDirectory(), () => false) : false
          return {
            name: d.name,
            path,
            kind: link ? 'link' : st.isDirectory() ? 'dir' : 'file',
            linkDir,
            size: st.size,
            mtime: st.mtimeMs,
            mode: st.mode
          }
        } catch {
          return null
        }
      })
    )
    return entries.filter((e): e is FileEntry => e !== null)
  },

  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path)
  },

  async rename(from: string, to: string): Promise<void> {
    if (existsSync(to)) throw new Error('A file with that name already exists')
    await fsp.rename(from, to)
  },

  async trash(paths: string[]): Promise<void> {
    for (const path of paths) await shell.trashItem(path)
  },

  async open(path: string): Promise<void> {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  }
}
