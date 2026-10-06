import { FOLDER_COLORS } from '@shared/defaults'
import { app, type MenuItem, type Tab } from './state.svelte'

export function tabMenu(tab: Tab, where: 'strip' | 'pane'): MenuItem[] {
  const target = $state.snapshot(tab.target)
  const name = app.targetTitle(target, tab.title)
  const split = app.splitOf(tab.id)
  const panes = app.paneIds(tab.id)
  const items: MenuItem[] = []
  if (tab.kind === 'ssh') {
    const look = { label: tab.label, color: tab.color }
    items.push({ label: 'Duplicate tab', action: () => app.openTab('ssh', target, tab.title, tab.command, look) })
  }
  if (tab.kind !== 'ssh' || tab.command) items.push({ label: 'Open terminal', action: () => app.openTab('ssh', target, name) })
  if (tab.kind !== 'sftp') items.push({ label: 'Open SFTP', action: () => app.openTab('sftp', target, name) })
  if (tab.kind !== 'docker') items.push({ label: 'Open Docker', action: () => app.openTab('docker', target, name) })
  items.push('sep')
  if (tab.kind !== 'edit') {
    items.push(
      { label: 'Split right', action: () => app.splitTab(tab.id, 'row') },
      { label: 'Split down', action: () => app.splitTab(tab.id, 'column') },
      { label: 'Split with host…', action: () => app.openPalette('all', { beside: tab.id, dir: 'row' }) }
    )
  }
  if (split) {
    const terminals = app.tabs.filter((t) => t.kind === 'ssh' && panes.includes(t.id)).length
    if (terminals > 1) {
      items.push({
        label: split.broadcast ? 'Stop broadcasting input' : 'Broadcast input to all panes',
        action: () => app.toggleBroadcast(split)
      })
    }
    if (where === 'pane') items.push({ label: 'Move to new tab', action: () => app.detachPane(tab.id) })
  }
  items.push(
    'sep',
    { label: split ? 'Rename pane' : 'Rename tab', action: () => app.renameTab(tab.id) },
    { swatches: FOLDER_COLORS, current: tab.color ?? null, pick: (color) => app.colorTab(tab.id, color) },
    'sep'
  )
  if (split && where === 'strip') items.push({ label: 'Close all panes', action: () => app.closeTabs(panes) })
  else items.push({ label: split ? 'Close pane' : 'Close tab', action: () => app.closeTab(tab.id) })
  items.push({
    label: 'Close other tabs',
    action: () => app.closeOtherTabs(tab.id),
    disabled: app.tabs.length <= panes.length
  })
  return items
}
