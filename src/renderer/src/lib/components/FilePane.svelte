<script lang="ts">
  import type { Snippet } from 'svelte'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import FolderPlus from '@lucide/svelte/icons/folder-plus'
  import Folder from '@lucide/svelte/icons/folder'
  import FileIcon from '@lucide/svelte/icons/file'
  import FileSymlink from '@lucide/svelte/icons/file-symlink'
  import type { FileEntry } from '@shared/types'
  import { FOLDER_COLORS } from '@shared/defaults'
  import { favoriteLabels, tint, type FolderMarks } from '$lib/folders'
  import { app, type MenuItem } from '$lib/state.svelte'
  import { bytes, date, mode, visibleName } from '$lib/format'
  import type { PathOps } from '$lib/paths'
  import { mod } from '$lib/keys'

  type Side = 'local' | 'remote'
  const DRAG_TYPE = 'application/x-bawkterm-files'

  let {
    side,
    title,
    ops,
    path = $bindable(),
    showHidden,
    disabled = false,
    sendLabel,
    list,
    onsend,
    onreceive,
    onmkdir,
    onrename,
    onremove,
    onopen,
    onedit,
    onterminal,
    tools,
    overlay,
    marks
  }: {
    side: Side
    title: string
    ops: PathOps
    path: string
    showHidden: boolean
    disabled?: boolean
    sendLabel: string
    list: (path: string) => Promise<FileEntry[]>
    onsend: (entries: FileEntry[]) => void
    onreceive: (paths: string[], from: Side | 'os') => void
    onmkdir: (path: string) => Promise<void>
    onrename: (from: string, to: string) => Promise<void>
    onremove: (entries: FileEntry[]) => Promise<void>
    onopen?: (entry: FileEntry) => void
    onedit?: (entry: FileEntry) => void
    onterminal?: (path: string) => void
    tools?: Snippet
    overlay?: Snippet
    marks?: FolderMarks
  } = $props()

  let entries = $state.raw<FileEntry[]>([])
  let loading = $state(false)
  let error = $state('')
  let selected = $state<string[]>([])
  let anchor = $state(-1)
  let sortKey = $state<'name' | 'size' | 'mtime'>('name')
  let sortDir = $state(1)
  let dropping = $state(false)
  let pathInput = $state('')
  let filter = $state('')
  let listEl = $state<HTMLDivElement>()
  let loadSeq = 0

  const isDirLike = (e: FileEntry): boolean => e.kind === 'dir' || e.linkDir

  const visible = $derived(
    entries
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => {
        const d = Number(isDirLike(b)) - Number(isDirLike(a))
        if (d) return d
        const v =
          sortKey === 'name'
            ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            : sortKey === 'size'
              ? a.size - b.size
              : a.mtime - b.mtime
        return v * sortDir
      })
  )

  const selectedEntries = $derived(visible.filter((e) => selected.includes(e.path)))
  const favoriteNames = $derived(favoriteLabels(marks?.favorites ?? []))

  export async function refresh(): Promise<void> {
    if (disabled || path === undefined) return
    const seq = ++loadSeq
    const target = path
    loading = true
    error = ''
    try {
      const result = await list(target)
      if (seq !== loadSeq) return
      entries = result
      selected = selected.filter((p) => result.some((e) => e.path === p))
    } catch (err) {
      if (seq !== loadSeq) return
      error = (err as Error).message
      entries = []
    } finally {
      if (seq === loadSeq) loading = false
    }
  }

  $effect(() => {
    pathInput = path
    void disabled
    filter = ''
    selected = []
    anchor = -1
    void refresh()
  })

  function navigate(to: string | null): void {
    if (to === null || to === path) return
    path = to
  }

  function activate(entry: FileEntry): void {
    if (isDirLike(entry)) navigate(entry.path)
    else onsend([entry])
  }

  function select(e: MouseEvent, entry: FileEntry, index: number): void {
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)]
      selected = visible.slice(a, b + 1).map((x) => x.path)
    } else if (e.ctrlKey || e.metaKey) {
      selected = selected.includes(entry.path) ? selected.filter((p) => p !== entry.path) : [...selected, entry.path]
      anchor = index
    } else {
      selected = [entry.path]
      anchor = index
    }
  }

  function setSort(key: typeof sortKey): void {
    if (sortKey === key) sortDir = -sortDir
    else {
      sortKey = key
      sortDir = 1
    }
  }

  async function mkdir(): Promise<void> {
    const name = await app.askText('New folder', 'name', '', 'Create')
    if (!name) return
    try {
      await onmkdir(ops.join(path, name))
      await refresh()
    } catch (err) {
      app.fail(err)
    }
  }

  async function rename(entry: FileEntry): Promise<void> {
    const name = await app.askText('Rename', 'new name', entry.name, 'Rename')
    if (!name || name === entry.name) return
    try {
      await onrename(entry.path, ops.join(path, name))
      await refresh()
    } catch (err) {
      app.fail(err)
    }
  }

  async function remove(list: FileEntry[]): Promise<void> {
    if (!list.length) return
    const what = list.length === 1 ? `"${visibleName(list[0].name)}"` : `${list.length} items`
    const message =
      side === 'local'
        ? `Move ${what} to the Recycle Bin?`
        : `Permanently delete ${what} on the server? Folders are deleted with everything inside.`
    if (!(await app.confirm('Delete', message))) return
    try {
      await onremove(list)
      await refresh()
    } catch (err) {
      app.fail(err)
      await refresh()
    }
  }

  function markItems(paths: string[]): MenuItem[] {
    if (!marks) return []
    const items: MenuItem[] = []
    if (paths.length === 1) {
      const on = marks.favorites.includes(paths[0])
      items.push({ label: on ? 'Remove from favorites' : 'Add to favorites', action: () => marks.setFavorite(paths[0], !on) })
    }
    const colors = new Set(paths.map((p) => marks.colors[p] ?? null))
    items.push({
      swatches: FOLDER_COLORS,
      current: colors.size === 1 ? [...colors][0] : null,
      pick: (color) => marks.setColor(paths, color)
    })
    return items
  }

  function favoriteMenu(e: MouseEvent, fav: string): void {
    if (!marks) return
    app.openMenu(e, [
      { label: 'Open', action: () => navigate(fav) },
      ...(onterminal ? [{ label: 'Open terminal here', action: () => onterminal(fav) }] : []),
      { label: 'Copy path', action: () => navigator.clipboard.writeText(fav) },
      'sep',
      ...markItems([fav])
    ])
  }

  function rowMenu(e: MouseEvent, entry: FileEntry, index: number): void {
    if (!selected.includes(entry.path)) select(e, entry, index)
    const targets = selected.includes(entry.path) ? selectedEntries : [entry]
    const items: MenuItem[] = []
    if (isDirLike(entry) && targets.length === 1) items.push({ label: 'Open', action: () => navigate(entry.path) })
    if (onterminal && isDirLike(entry) && targets.length === 1) {
      items.push({ label: 'Open terminal here', action: () => onterminal(entry.path) })
    }
    if (onedit && entry.kind === 'file' && targets.length === 1) {
      items.push({ label: 'Edit in editor', action: () => onedit(entry) })
    }
    if (onopen && !isDirLike(entry) && targets.length === 1) {
      items.push({ label: 'Open with default app', action: () => onopen(entry) })
    }
    if (marks && targets.every(isDirLike)) items.push('sep', ...markItems(targets.map((t) => t.path)), 'sep')
    items.push(
      { label: `${sendLabel} ${targets.length > 1 ? `${targets.length} items` : ''}`.trim(), action: () => onsend(targets) },
      'sep',
      { label: 'Rename', action: () => rename(entry), disabled: targets.length !== 1 },
      { label: 'Copy path', action: () => navigator.clipboard.writeText(entry.path) },
      { label: 'New folder', action: mkdir },
      'sep',
      { label: 'Delete', danger: true, action: () => remove(targets) }
    )
    app.openMenu(e, items)
  }

  function paneMenu(e: MouseEvent): void {
    if (e.target !== e.currentTarget) return
    selected = []
    app.openMenu(e, [
      ...(onterminal ? [{ label: 'Open terminal here', action: () => onterminal(path) }] : []),
      { label: 'New folder', action: mkdir },
      { label: 'Refresh', action: refresh },
      { label: 'Copy path', action: () => navigator.clipboard.writeText(path) },
      ...(marks ? ['sep' as const, ...markItems([path])] : [])
    ])
  }

  function onkeydown(e: KeyboardEvent): void {
    const i = visible.findIndex((x) => x.path === selected[selected.length - 1])
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
      if (visible[next]) {
        selected = [visible[next].path]
        anchor = next
        listEl?.querySelectorAll('.row')[next]?.scrollIntoView({ block: 'nearest' })
      }
    } else if (e.key === 'Enter' && selectedEntries.length === 1) {
      activate(selectedEntries[0])
    } else if (e.key === 'Backspace') {
      if (filter) filter = filter.slice(0, -1)
      else navigate(ops.parent(path))
    } else if (e.key === 'Escape' && filter) {
      e.stopPropagation()
      filter = ''
    } else if (e.key === 'Delete') {
      void remove(selectedEntries)
    } else if (e.key === 'F2' && selectedEntries.length === 1) {
      void rename(selectedEntries[0])
    } else if (e.key === 'F5') {
      void refresh()
    } else if (e.key === 'a' && mod(e)) {
      e.preventDefault()
      selected = visible.map((x) => x.path)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      filter += e.key
      const first = visible[0]
      selected = first ? [first.path] : []
      anchor = first ? 0 : -1
    }
  }

  function dragstart(e: DragEvent, entry: FileEntry): void {
    const paths = selected.includes(entry.path) ? selectedEntries.map((x) => x.path) : [entry.path]
    e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify({ side, paths }))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  }

  function accepts(e: DragEvent): boolean {
    const types = e.dataTransfer?.types ?? []
    return types.includes(DRAG_TYPE) || (side === 'remote' && types.includes('Files'))
  }

  function dragover(e: DragEvent): void {
    if (disabled || !accepts(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    dropping = true
  }

  function drop(e: DragEvent): void {
    dropping = false
    if (disabled || !e.dataTransfer) return
    e.preventDefault()
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (raw) {
      const payload = JSON.parse(raw) as { side: Side; paths: string[] }
      if (payload.side !== side) onreceive(payload.paths, payload.side)
      return
    }
    const files = [...e.dataTransfer.files].map((f) => window.api.app.pathForFile(f)).filter(Boolean)
    if (files.length && side === 'remote') onreceive(files, 'os')
  }
</script>

<section class="pane" class:dropping>
  <header>
    <div class="title">
      <span class="side">{side}</span>
      <span class="name">{title}</span>
      {#if tools}{@render tools()}{/if}
      {#if selectedEntries.length}
        <button type="button" class="btn small" onclick={() => onsend(selectedEntries)} {disabled}>
          {sendLabel} {selectedEntries.length}
        </button>
      {/if}
    </div>
    {#if filter}
      <div class="filter">
        <span class="muted">filter</span>
        <span class="strong">{filter}</span>
        <span class="muted">· {visible.length} match{visible.length === 1 ? '' : 'es'} · esc clears</span>
        <button type="button" class="btn small icon ghost" aria-label="Clear filter" onclick={() => (filter = '')}>×</button>
      </div>
    {/if}
    <div class="tools">
      <button type="button" class="btn small icon ghost" aria-label="Up" title="Up (Backspace)" disabled={disabled || ops.parent(path) === null} onclick={() => navigate(ops.parent(path))}><ArrowUp /></button>
      <form
        class="path"
        onsubmit={(e) => {
          e.preventDefault()
          navigate(pathInput.trim())
        }}
      >
        <input bind:value={pathInput} spellcheck="false" {disabled} aria-label="{side} path" placeholder={side === 'local' ? 'drives' : '/'} />
      </form>
      <button type="button" class="btn small icon ghost" aria-label="Refresh" title="Refresh (F5)" {disabled} onclick={refresh}>
        <RefreshCw class={loading ? 'spin' : ''} />
      </button>
      <button type="button" class="btn small icon ghost" aria-label="New folder" title="New folder" {disabled} onclick={mkdir}><FolderPlus /></button>
    </div>
    {#if marks?.favorites.length}
      <div class="favorites" role="toolbar" aria-label="favorites">
        {#each marks.favorites as fav (fav)}
          <button
            type="button"
            class={['fav', fav === path && 'here', marks.colors[fav] && 'tinted']}
            style:--tint={tint(marks.colors[fav])}
            title={fav}
            {disabled}
            onclick={() => navigate(fav)}
            oncontextmenu={(e) => favoriteMenu(e, fav)}
          >
            <Folder size={12} class="icon" />
            <span class="fav-name">{favoriteNames.get(fav)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </header>

  <div class="cols" class:remote={side === 'remote'}>
    <button type="button" onclick={() => setSort('name')}>name {sortKey === 'name' ? (sortDir > 0 ? '↑' : '↓') : ''}</button>
    <button type="button" class="num" onclick={() => setSort('size')}>size {sortKey === 'size' ? (sortDir > 0 ? '↑' : '↓') : ''}</button>
    <button type="button" onclick={() => setSort('mtime')}>modified {sortKey === 'mtime' ? (sortDir > 0 ? '↑' : '↓') : ''}</button>
    {#if side === 'remote'}<span>mode</span>{/if}
  </div>

  <div
    class="list"
    role="listbox"
    tabindex="0"
    aria-multiselectable="true"
    bind:this={listEl}
    {onkeydown}
    oncontextmenu={paneMenu}
    ondragover={dragover}
    ondragleave={() => (dropping = false)}
    ondrop={drop}
    onmousedown={(e) => e.target === e.currentTarget && (selected = [])}
  >
    {#if error}
      <p class="state error selectable">{error}</p>
    {:else if !loading && !visible.length && !disabled}
      <p class="state muted">empty folder</p>
    {/if}
    {#each visible as entry, i (entry.path)}
      <div
        class={['row', side === 'remote' && 'remote', selected.includes(entry.path) && 'selected']}
        role="option"
        tabindex="-1"
        aria-selected={selected.includes(entry.path)}
        draggable="true"
        ondragstart={(e) => dragstart(e, entry)}
        onmousedown={(e) => e.button === 0 && select(e, entry, i)}
        ondblclick={() => activate(entry)}
        oncontextmenu={(e) => rowMenu(e, entry, i)}
      >
        <span class={['name', isDirLike(entry) && marks?.colors[entry.path] && 'tinted']} style:--tint={isDirLike(entry) ? tint(marks?.colors[entry.path]) : undefined}>
          {#if isDirLike(entry)}<Folder size={14} class="icon dir" />{:else if entry.kind === 'link'}<FileSymlink size={14} class="icon" />{:else}<FileIcon size={14} class="icon" />{/if}
          <span class="text">{visibleName(entry.name)}</span>
        </span>
        <span class="num muted">{isDirLike(entry) ? '' : bytes(entry.size)}</span>
        <span class="muted">{date(entry.mtime)}</span>
        {#if side === 'remote'}<span class="muted">{mode(entry.mode)}</span>{/if}
      </div>
    {/each}
  </div>

  {#if overlay}
    <div class="overlay">{@render overlay()}</div>
  {/if}
</section>

<style>
  .pane {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .pane.dropping {
    border-color: var(--text-strong);
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 10px 8px 14px;
    border-bottom: 1px solid var(--border-weak);
    background: var(--bg-weak);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 24px;
  }
  .side {
    color: var(--text-weak);
    font-size: 11px;
  }
  .name {
    flex: 1;
    overflow: hidden;
    color: var(--text-strong);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .path {
    flex: 1;
    min-width: 0;
  }
  .path input {
    width: 100%;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text-strong);
    font: inherit;
    font-size: 12px;
    outline: none;
    user-select: text;
  }
  .path input:focus {
    border-color: var(--border);
  }
  .cols,
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 80px 130px;
    gap: 10px;
    align-items: center;
  }
  .cols.remote,
  .row.remote {
    grid-template-columns: minmax(0, 1fr) 80px 130px 84px;
  }
  .cols {
    padding: 4px 14px;
    border-bottom: 1px solid var(--border-weak);
    color: var(--text-weak);
    font-size: 11px;
  }
  .cols button {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .cols button:hover {
    color: var(--text-strong);
  }
  .num {
    text-align: right;
  }
  .cols .num {
    text-align: right;
  }
  .list {
    flex: 1;
    min-height: 0;
    padding: 4px;
    overflow-y: auto;
    outline: none;
  }
  .row {
    height: 26px;
    padding: 0 10px;
    border-radius: 3px;
    font-size: 12px;
    cursor: default;
  }
  .row:hover {
    background: var(--bg-weak);
  }
  .row.selected {
    background: var(--bg-selected);
    color: var(--text-strong);
  }
  .list:focus-within .row.selected,
  .list:focus .row.selected {
    box-shadow: inset 2px 0 0 var(--focus);
  }
  .row .name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 400;
  }
  .row .text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row :global(.icon) {
    flex: none;
    color: var(--icon);
  }
  .row :global(.icon.dir) {
    color: var(--text);
  }
  .row .tinted :global(.icon.dir),
  .fav.tinted :global(.icon) {
    color: var(--tint);
    fill: color-mix(in oklch, var(--tint) 30%, transparent);
  }
  .favorites {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .fav {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    max-width: 180px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--border-weak);
    border-radius: 3px;
    background: none;
    color: var(--text);
    font-size: 11px;
    cursor: pointer;
  }
  .fav:hover:not(:disabled) {
    background: var(--bg-weak-hover);
    color: var(--text-strong);
  }
  .fav.here {
    border-color: var(--border);
    background: var(--bg-selected);
    color: var(--text-strong);
  }
  .fav:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .fav :global(.icon) {
    flex: none;
    color: var(--icon);
  }
  .fav-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    padding: 16px 10px;
  }
  .error {
    color: var(--danger);
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 90%, transparent);
  }
</style>
