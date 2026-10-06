import type { HostExportFormat, ImportSummary } from '@shared/types'
import { app, type MenuItem } from './state.svelte'

const api = window.api.transfer

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

async function report(run: () => Promise<ImportSummary | null>, verb: string): Promise<void> {
  let res: ImportSummary | null
  try {
    res = await run()
  } catch (err) {
    app.fail(err)
    return
  }
  if (!res) return
  const parts = [count(res.hosts, 'host')]
  if (res.keys) parts.push(count(res.keys, 'key'))
  if (res.identities) parts.push(count(res.identities, 'identity', 'identities'))
  if (res.snippets) parts.push(count(res.snippets, 'snippet'))
  const message = `${verb} ${parts.join(', ')}.`
  if (!res.skipped.length) {
    app.toast(message)
    return
  }
  const list = res.skipped.join('\n')
  const copy = await app.ask({
    title: `${verb} with notes`,
    message: `${message} ${count(res.skipped.length, 'item')} left out or changed:`,
    detail: list,
    fields: [],
    confirmLabel: 'Copy list',
    cancelLabel: 'Close'
  })
  if (copy) window.api.app.copy(list)
}

export const importFromFile = (): Promise<void> => report(() => api.importFile(), 'Added')

export async function openImportMenu(anchor: HTMLElement): Promise<void> {
  const sources = await api.sources().catch(() => [])
  const items: MenuItem[] = sources.map((s) => ({
    label: `${s.label} (${count(s.count, 'host')})`,
    action: () => void report(() => api.importSource(s.id), 'Imported')
  }))
  if (!items.length) items.push({ label: 'nothing found on this computer', action: () => {}, disabled: true })
  items.push('sep', { label: 'From a file or backup…', action: () => void importFromFile() })
  app.openMenuBelow(anchor, items)
}

async function exportHosts(format: HostExportFormat): Promise<void> {
  const path = await api.exportHosts(format).catch((err) => app.fail(err))
  if (path) app.toast(`Saved ${path}`)
}

export async function exportBackup(): Promise<void> {
  const pw = await app.askMasterPassword(
    'The backup holds your hosts, passwords, keys, identities and snippets, encrypted with your master password. Keep the password: restoring needs it, even after you change it.',
    'Save backup'
  )
  if (!pw) return
  const path = await api.exportBackup(pw).catch((err) => app.fail(err))
  if (path) app.toast(`Saved ${path}`)
}

export function openExportMenu(anchor: HTMLElement): void {
  app.openMenuBelow(anchor, [
    { label: 'SSH config file…', action: () => void exportHosts('ssh-config') },
    { label: 'CSV file…', action: () => void exportHosts('csv') },
    'sep',
    { label: 'Encrypted backup…', action: () => void exportBackup() }
  ])
}
