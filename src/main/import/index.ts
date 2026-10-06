import { promises as fsp } from 'node:fs'
import { extname } from 'node:path'
import type { ImportSource, ImportSourceId, ImportSummary } from '@shared/types'
import { looksLikeBackup, readBackup, restoreBackup, WrongPassword } from '../backup'
import type { Vault } from '../vault'
import { commit, type Scan } from './commit'
import { csvHosts } from './csv'
import { filezillaSites, scanFilezilla } from './filezilla'
import { looksLikeMobaxterm, mobaxtermSessions, scanMobaxterm } from './mobaxterm'
import { scanPutty } from './putty'
import { looksLikeSshConfig, scanSshConfig } from './ssh-config'
import { decodeText } from './text'
import { scanWinscp, winscpFromIni } from './winscp'

const SOURCES: Record<ImportSourceId, { label: string; scan: () => Promise<Scan> }> = {
  'ssh-config': { label: '~/.ssh/config', scan: () => scanSshConfig() },
  putty: { label: 'PuTTY', scan: () => scanPutty('putty') },
  kitty: { label: 'KiTTY', scan: () => scanPutty('kitty') },
  winscp: { label: 'WinSCP', scan: scanWinscp },
  filezilla: { label: 'FileZilla', scan: scanFilezilla },
  mobaxterm: { label: 'MobaXterm', scan: scanMobaxterm }
}

export const IMPORT_SOURCES = Object.keys(SOURCES) as ImportSourceId[]

const MAX_FILE = 20 * 1024 * 1024

export async function findSources(): Promise<ImportSource[]> {
  const found = await Promise.all(
    IMPORT_SOURCES.map(async (id) => ({
      id,
      label: SOURCES[id].label,
      count: await SOURCES[id]
        .scan()
        .then((s) => s.hosts.length)
        .catch(() => 0)
    }))
  )
  return found.filter((s) => s.count > 0)
}

export async function importSource(vault: Vault, id: ImportSourceId): Promise<ImportSummary> {
  return commit(vault, await SOURCES[id].scan())
}

export async function importFile(
  vault: Vault,
  file: string,
  askPassword: (retry: boolean) => Promise<string | null>
): Promise<ImportSummary | null> {
  if ((await fsp.stat(file)).size > MAX_FILE) throw new Error('This file is too large to import')
  const text = decodeText(await fsp.readFile(file))
  if (looksLikeBackup(text)) {
    let wrong = 0
    for (;;) {
      const password = await askPassword(wrong > 0)
      if (password === null) return null
      try {
        return await restoreBackup(vault, await readBackup(text, password))
      } catch (err) {
        if (!(err instanceof WrongPassword) || ++wrong === 3) throw err
      }
    }
  }
  const ext = extname(file).toLowerCase()
  if (/<FileZilla3[\s>]/.test(text)) return commit(vault, filezillaSites(text))
  if (looksLikeMobaxterm(text)) return commit(vault, mobaxtermSessions(text))
  if (/^\[Sessions\\/m.test(text)) return commit(vault, winscpFromIni(text))
  if (ext === '.csv' || ext === '.tsv') return commit(vault, csvHosts(text))
  if (looksLikeSshConfig(text)) return commit(vault, await scanSshConfig(file, text))
  if (/PRIVATE KEY-----|^PuTTY-User-Key-File-/m.test(text)) throw new Error('This is a key. Add it under keychain → Import key.')
  throw new Error('bawkterm does not recognize this file. It reads SSH config, CSV, FileZilla, MobaXterm, WinSCP.ini and bawkterm backup files.')
}
