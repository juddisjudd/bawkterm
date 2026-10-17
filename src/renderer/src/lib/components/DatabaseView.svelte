<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Compartment, EditorState } from '@codemirror/state'
  import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder } from '@codemirror/view'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { LanguageDescription, bracketMatching } from '@codemirror/language'
  import { languages } from '@codemirror/language-data'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Eye from '@lucide/svelte/icons/eye'
  import Play from '@lucide/svelte/icons/play'
  import Plus from '@lucide/svelte/icons/plus'
  import Square from '@lucide/svelte/icons/square'
  import SquareTerminal from '@lucide/svelte/icons/square-terminal'
  import Table2 from '@lucide/svelte/icons/table-2'
  import type { DbCell, DbChange, DbColumn, DbInfo, DbKey, DbPage, DbResult, DbTable, DbValue } from '@shared/types'
  import { app, serverTarget, type Tab } from '$lib/state.svelte'
  import { editorHighlight, editorTheme } from '$lib/editor'
  import { bytes } from '$lib/format'
  import { MOD } from '$lib/keys'
  import Checkbox from './Checkbox.svelte'
  import Drawer from './Drawer.svelte'

  interface Field {
    column: DbColumn
    original: DbCell | undefined
    text: string
    isNull: boolean
    touched: boolean
  }

  let { tab, active }: { tab: Tab; active: boolean } = $props()

  const api = window.api
  const LIMIT = 200
  const INT64 = 2n ** 63n
  const INTEGER = /^[+-]?\d+$/
  const REAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
  const path = $derived(tab.edit!.path)
  // svelte-ignore state_referenced_locally
  let sessionId = tab.edit!.sessionId

  let phase = $state<'loading' | 'ready' | 'failed'>('loading')
  let error = $state('')
  let info = $state.raw<DbInfo | null>(null)
  let tables = $state.raw<DbTable[]>([])
  let dirty = $state(false)
  let saving = $state(false)
  let mode = $state<'table' | 'sql'>('table')
  let table = $state('')
  let data = $state.raw<DbPage | null>(null)
  let pageError = $state('')
  let offset = $state(0)
  let sort = $state.raw<{ column: string; desc: boolean } | null>(null)
  let filter = $state('')
  let picked = $state(-1)
  let editing = $state<{ key: DbKey | null; isNew: boolean; fields: Field[] } | null>(null)
  let result = $state.raw<DbResult | null>(null)
  let running = $state(false)
  let gridEl = $state<HTMLDivElement>()
  let sqlView: EditorView | undefined
  let stopped = false
  let pageSeq = 0
  let filterTimer: ReturnType<typeof setTimeout> | undefined

  const readOnly = $derived(!!info?.readOnly)
  const canEdit = $derived(!!data?.editable && !readOnly && !saving)
  const tableList = $derived(tables.filter((t) => t.kind === 'table'))
  const viewList = $derived(tables.filter((t) => t.kind === 'view'))
  const range = $derived(
    !data ? '' : data.total ? `${offset + 1}–${offset + data.rows.length} of ${data.total.toLocaleString()}` : '0 rows'
  )

  $effect(() => {
    tab.dirty = dirty
  })

  const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
  const isBlob = (v: DbCell | undefined): v is { blob: number } => typeof v === 'object' && v !== null && 'blob' in v
  const isPreview = (v: DbCell | undefined): v is { text: string; length: number } =>
    typeof v === 'object' && v !== null && 'text' in v
  const failure = (message: string): DbResult => ({
    columns: [],
    rows: [],
    more: false,
    statements: 0,
    changes: 0,
    dirty,
    error: message
  })

  // the SFTP tab's session is reused; if that tab closed, this view opens its own
  async function withSession<T>(task: (id: string) => Promise<T>): Promise<T> {
    try {
      return await task(sessionId)
    } catch (err) {
      if (!/not connected/.test((err as Error).message)) throw err
      await api.sftp.open(tab.id, serverTarget(tab))
      sessionId = tab.id
      return task(sessionId)
    }
  }

  async function load(): Promise<void> {
    phase = 'loading'
    error = ''
    editing = null
    try {
      const loaded = await withSession((id) => api.db.load(tab.id, id, path))
      info = loaded
      tables = loaded.tables
      dirty = false
      if (!tables.some((t) => t.name === table)) {
        table = tables[0]?.name ?? ''
        offset = 0
        sort = null
        filter = ''
      }
      if (!table) mode = 'sql'
      phase = 'ready'
      if (mode === 'table') await fetchPage()
    } catch (err) {
      phase = 'failed'
      error = (err as Error).message
    }
  }

  async function fetchPage(): Promise<void> {
    const seq = ++pageSeq
    try {
      const page = await api.db.page(tab.id, { table, offset, limit: LIMIT, sort, filter })
      if (seq !== pageSeq) return
      // deleting rows can leave this page past the end
      if (offset && offset >= page.total) {
        offset = Math.max(0, Math.ceil(page.total / LIMIT) - 1) * LIMIT
        return fetchPage()
      }
      data = page
      pageError = ''
      picked = Math.min(picked, page.rows.length - 1)
    } catch (err) {
      if (seq !== pageSeq) return
      data = null
      pageError = (err as Error).message
    }
  }

  async function refreshTables(): Promise<void> {
    tables = await api.db.tables(tab.id)
  }

  function selectTable(name: string): void {
    mode = 'table'
    if (name !== table) {
      table = name
      offset = 0
      sort = null
      filter = ''
      picked = -1
      data = null
    }
    void fetchPage()
  }

  async function openSql(): Promise<void> {
    mode = 'sql'
    await tick()
    if (!sqlView) return
    if (!sqlView.state.doc.length && table) {
      const text = `SELECT * FROM ${quote(table)} LIMIT 100;`
      sqlView.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: text.length } })
    }
    sqlView.requestMeasure()
    sqlView.focus()
  }

  function toggleSort(column: string): void {
    sort = sort?.column !== column ? { column, desc: false } : sort.desc ? null : { column, desc: true }
    offset = 0
    void fetchPage()
  }

  function onFilter(): void {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(() => {
      offset = 0
      picked = -1
      void fetchPage()
    }, 250)
  }

  function go(step: number): void {
    offset = Math.max(0, offset + step * LIMIT)
    picked = -1
    void fetchPage()
  }

  function realText(n: number): string {
    return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(1) : String(n)
  }

  function shown(v: DbCell): string {
    if (v === null) return 'NULL'
    if (typeof v === 'number') return realText(v)
    if (typeof v !== 'object') return String(v)
    return 'blob' in v ? `blob ${bytes(v.blob)}` : `${v.text}…`
  }

  function cellClass(v: DbCell): string {
    if (v === null) return 'null'
    if (typeof v === 'number' || typeof v === 'bigint') return 'num'
    return isBlob(v) ? 'blob' : ''
  }

  function textOf(v: DbCell | undefined): string {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return realText(v)
    if (typeof v !== 'object') return String(v)
    return 'text' in v ? v.text : ''
  }

  function field(column: DbColumn, original: DbCell | undefined): Field {
    return { column, original, text: textOf(original), isNull: original === null, touched: false }
  }

  async function openRow(i: number): Promise<void> {
    if (!data) return
    picked = i
    const { key, cells } = data.rows[i]
    const columns = data.columns
    try {
      const full = key ? await api.db.row(tab.id, table, key) : cells
      editing = { key, isNew: false, fields: columns.map((c, j) => field(c, full[j])) }
    } catch (err) {
      app.fail(err)
    }
  }

  function newRow(): void {
    if (!data || !canEdit) return
    editing = { key: null, isNew: true, fields: data.columns.filter((c) => !c.generated).map((c) => field(c, undefined)) }
  }

  const locked = (f: Field): boolean => !canEdit || f.column.generated || isBlob(f.original) || isPreview(f.original)

  function hint(f: Field): string {
    if (f.isNull) return 'NULL'
    if (f.original !== undefined) return ''
    if (f.column.pk && f.column.type.toUpperCase() === 'INTEGER') return 'automatic'
    if (f.column.default !== null) return `default ${f.column.default}`
    return f.column.notNull ? 'required' : 'NULL'
  }

  function changed(f: Field): boolean {
    if (!f.touched) return false
    if (f.original === undefined) return true
    return f.isNull ? f.original !== null : f.original === null || f.text !== textOf(f.original)
  }

  // columns with a declared type convert text themselves; untyped ones keep numbers as numbers only if they were
  function valueOf(f: Field): DbValue {
    if (f.isNull) return null
    const numeric = typeof f.original === 'bigint' || typeof f.original === 'number' || !f.column.type
    const t = f.text.trim()
    if (numeric && INTEGER.test(t)) {
      const n = BigInt(t)
      if (n >= -INT64 && n < INT64) return n
    }
    if (numeric && REAL.test(t)) return Number(t)
    return f.text
  }

  async function apply(): Promise<void> {
    if (!editing || !canEdit) return
    const changes: DbChange[] = editing.fields.filter(changed).map((f) => ({ column: f.column.name, value: valueOf(f) }))
    const key = $state.snapshot(editing.key) as DbKey | null
    try {
      if (editing.isNew) dirty = await api.db.insert(tab.id, table, changes)
      else if (key && changes.length) dirty = await api.db.update(tab.id, table, key, changes)
      editing = null
      await Promise.all([fetchPage(), refreshTables()])
    } catch (err) {
      app.fail(err)
    }
  }

  async function removeRow(key: DbKey | null): Promise<void> {
    if (!key || !canEdit) return
    if (!(await app.confirm('Delete row', `Delete this row from ${table}? The server copy changes when you save.`))) return
    try {
      dirty = await api.db.remove(tab.id, table, [key])
      editing = null
      await Promise.all([fetchPage(), refreshTables()])
    } catch (err) {
      app.fail(err)
    }
  }

  async function setNull(i: number, j: number): Promise<void> {
    const key = data?.rows[i].key
    if (!data || !key) return
    try {
      dirty = await api.db.update(tab.id, table, key, [{ column: data.columns[j].name, value: null }])
      await fetchPage()
    } catch (err) {
      app.fail(err)
    }
  }

  async function copyValue(i: number, j: number): Promise<void> {
    if (!data) return
    const { key, cells } = data.rows[i]
    try {
      const v = isPreview(cells[j]) && key ? (await api.db.row(tab.id, table, key))[j] : cells[j]
      await navigator.clipboard.writeText(textOf(v))
    } catch (err) {
      app.fail(err)
    }
  }

  function cellMenu(e: MouseEvent, i: number, j: number): void {
    const page = data
    if (!page) return
    picked = i
    const { key, cells } = page.rows[i]
    const editable = canEdit && !!key
    app.openMenu(e, [
      { label: editable ? 'Edit row' : 'View row', action: () => void openRow(i) },
      { label: 'Copy value', action: () => void copyValue(i, j) },
      ...(editable
        ? [
            { label: 'Set to NULL', action: () => void setNull(i, j), disabled: page.columns[j].generated || cells[j] === null },
            'sep' as const,
            { label: 'Delete row', danger: true, action: () => void removeRow(key) }
          ]
        : [])
    ])
  }

  function gridKey(e: KeyboardEvent): void {
    const rows = data?.rows ?? []
    if (!rows.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      picked = Math.min(rows.length - 1, Math.max(0, picked + (e.key === 'ArrowDown' ? 1 : -1)))
      void tick().then(() => gridEl?.querySelector(`tr[data-i="${picked}"]`)?.scrollIntoView({ block: 'nearest' }))
    } else if (e.key === 'Enter' && picked >= 0) {
      e.preventDefault()
      void openRow(picked)
    } else if (e.key === 'Delete' && picked >= 0) {
      e.preventDefault()
      void removeRow(rows[picked].key)
    }
  }

  async function run(): Promise<void> {
    if (!sqlView || running) return
    const { state } = sqlView
    const sel = state.selection.main
    const sql = sel.empty ? state.sliceDoc() : state.sliceDoc(sel.from, sel.to)
    if (!sql.trim()) return
    running = true
    stopped = false
    try {
      result = await api.db.query(tab.id, sql)
      dirty = result.dirty
      await refreshTables()
    } catch (err) {
      if (!stopped) result = failure((err as Error).message)
    } finally {
      running = false
    }
  }

  // the worker cannot be interrupted, so stopping ends it and loads the server copy again
  async function stop(): Promise<void> {
    const discard = 'Stopping reloads the database from the server and discards your unsaved changes.'
    if (dirty && !(await app.confirm('Stop query', discard, 'Stop and discard'))) return
    if (!running) return
    stopped = true
    await api.db.close(tab.id)
    await load()
    result = failure('Stopped. The database was loaded again from the server.')
  }

  async function save(force = false): Promise<void> {
    if (phase !== 'ready' || saving || readOnly || (!dirty && !force)) return
    saving = true
    let conflict = false
    try {
      const res = await withSession((id) => api.db.save(tab.id, id, force))
      conflict = res.conflict
      if (!res.conflict && info) {
        dirty = false
        info = { ...info, size: res.size }
      }
    } catch (err) {
      app.fail(err)
    } finally {
      saving = false
    }
    if (!conflict) return
    const answer = await app.ask({
      title: 'Database changed on the server',
      message: `${path} changed after you opened it.`,
      fields: [],
      confirmLabel: '',
      choices: [
        { id: 'overwrite', label: 'Overwrite with mine', danger: true },
        { id: 'reload', label: 'Reload theirs' }
      ]
    })
    if (answer?.choice === 'overwrite') await save(true)
    else if (answer?.choice === 'reload') await load()
  }

  async function reload(): Promise<void> {
    if (dirty && !(await app.confirm('Reload from server', 'Discard your changes and load the server copy?', 'Discard and reload'))) return
    await load()
  }

  function onkeydown(e: KeyboardEvent): void {
    if (!active || e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return
    e.preventDefault()
    void save()
  }

  function sqlEditor(node: HTMLDivElement): () => void {
    const language = new Compartment()
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          placeholder('SELECT * FROM …'),
          keymap.of([{ key: 'Mod-Enter', preventDefault: true, run: () => (void run(), true) }, ...defaultKeymap, ...historyKeymap]),
          editorTheme,
          editorHighlight,
          language.of([]),
          EditorView.lineWrapping
        ]
      })
    })
    sqlView = view
    void LanguageDescription.matchLanguageName(languages, 'SQLite')
      ?.load()
      .then((support) => view.dispatch({ effects: language.reconfigure(support) }))
    return () => {
      view.destroy()
      sqlView = undefined
    }
  }

  onMount(() => void load())
</script>

<svelte:window {onkeydown} />

{#snippet cells(row: DbCell[], i: number, menu: boolean)}
  {#each row as v, j}
    <td class={cellClass(v)} oncontextmenu={menu ? (e) => cellMenu(e, i, j) : undefined}>{shown(v)}</td>
  {/each}
{/snippet}

<div class="db">
  {#if phase === 'failed'}
    <div class="state">
      <p class="error selectable">{error}</p>
      <div class="actions">
        <button type="button" class="btn small" onclick={load}>Try again</button>
        <button type="button" class="btn small ghost" onclick={() => app.closeTab(tab.id)}>Close tab</button>
      </div>
    </div>
  {:else if !info}
    <p class="state muted">opening {path}…</p>
  {:else}
    <div class="body">
      <nav class="side" aria-label="tables">
        <button type="button" class={['item', mode === 'sql' && 'here']} onclick={openSql}>
          <SquareTerminal size={14} class="icon" /><span class="name">SQL</span>
        </button>
        {#if tableList.length}<p class="group">tables</p>{/if}
        {#each tableList as t (t.name)}
          <button type="button" class={['item', mode === 'table' && table === t.name && 'here']} title={t.name} onclick={() => selectTable(t.name)}>
            <Table2 size={14} class="icon" /><span class="name">{t.name}</span><span class="count">{t.rows?.toLocaleString() ?? ''}</span>
          </button>
        {/each}
        {#if viewList.length}<p class="group">views</p>{/if}
        {#each viewList as t (t.name)}
          <button type="button" class={['item', mode === 'table' && table === t.name && 'here']} title={t.name} onclick={() => selectTable(t.name)}>
            <Eye size={14} class="icon" /><span class="name">{t.name}</span>
          </button>
        {/each}
      </nav>

      <section class="main">
        {#if info.readOnly}<p class="banner">{info.readOnly}</p>{/if}

        <div class="pane" hidden={mode !== 'table'}>
          <header class="bar">
            <span class="title" title={table}>{table}</span>
            <input
              class="filter"
              type="search"
              placeholder="filter rows"
              spellcheck="false"
              aria-label="filter rows"
              bind:value={filter}
              oninput={onFilter}
            />
            <button type="button" class="btn small" disabled={!canEdit} onclick={newRow}><Plus /> Add row</button>
            <span class="pager">
              <button type="button" class="btn small icon ghost" aria-label="Previous rows" disabled={!offset} onclick={() => go(-1)}><ChevronLeft /></button>
              <span>{range}</span>
              <button
                type="button"
                class="btn small icon ghost"
                aria-label="Next rows"
                disabled={!data || offset + LIMIT >= data.total}
                onclick={() => go(1)}><ChevronRight /></button
              >
            </span>
          </header>
          <div class="grid" role="grid" tabindex="0" aria-label="rows of {table}" bind:this={gridEl} onkeydown={gridKey}>
            {#if pageError}
              <p class="state error selectable">{pageError}</p>
            {:else if data}
              <table>
                <thead>
                  <tr>
                    {#each data.columns as c (c.name)}
                      <th>
                        <button type="button" title={`${c.name} ${c.type}`.trim()} onclick={() => toggleSort(c.name)}>
                          {c.name}{#if sort?.column === c.name}<span>{sort.desc ? ' ↓' : ' ↑'}</span>{/if}
                        </button>
                      </th>
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each data.rows as r, i}
                    <tr class={[i === picked && 'picked']} data-i={i} onmousedown={() => (picked = i)} ondblclick={() => openRow(i)}>
                      {@render cells(r.cells, i, true)}
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if !data.rows.length}<p class="state muted">{filter ? 'no rows match the filter' : 'no rows'}</p>{/if}
            {/if}
          </div>
        </div>

        <div class="pane" hidden={mode !== 'sql'}>
          <div
            class="editor"
            style:font-family={app.settings.terminalFontFamily}
            style:font-size="{app.settings.terminalFontSize}px"
            {@attach sqlEditor}
          ></div>
          <header class="bar">
            {#if running}
              <button type="button" class="btn small" onclick={stop}><Square /> Stop</button>
            {:else}
              <button type="button" class="btn small strong" title="Run ({MOD}+Enter)" onclick={run}><Play /> Run</button>
            {/if}
            <span class="muted">
              {#if running}
                running…
              {:else if result && !result.error}
                {#if result.columns.length}
                  {result.more ? `first ${result.rows.length} rows` : `${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'}`}
                {:else}
                  done, {result.changes} {result.changes === 1 ? 'row' : 'rows'} changed
                {/if}
              {:else if !result}
                runs the selection, or everything when nothing is selected
              {/if}
            </span>
          </header>
          <div class="grid">
            {#if result?.error}
              <p class="state error selectable">{result.error}</p>
            {:else if result?.columns.length}
              <table>
                <thead>
                  <tr>
                    {#each result.columns as name}<th><span class="head">{name}</span></th>{/each}
                  </tr>
                </thead>
                <tbody>
                  {#each result.rows as row, i}
                    <tr>{@render cells(row, i, false)}</tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        </div>
      </section>
    </div>

    <footer>
      <span class="path selectable" title={path}>{path}</span>
      <span>{bytes(info.size)}</span>
      <span>{readOnly ? 'read-only' : dirty ? 'not saved to the server' : 'saved'}</span>
      <button type="button" class="btn small ghost" disabled={phase !== 'ready' || saving} onclick={reload}>Reload</button>
      {#if !readOnly}
        <button
          type="button"
          class="btn small strong"
          disabled={phase !== 'ready' || !dirty || saving}
          title="Save to the server ({MOD}+S)"
          onclick={() => save()}
        >
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      {/if}
    </footer>
    {#if phase === 'loading'}
      <p class="overlay muted">loading {path}…</p>
    {/if}
  {/if}
</div>

{#if editing}
  <Drawer title={editing.isNew ? 'New row' : canEdit && editing.key ? 'Edit row' : 'Row'} onclose={() => (editing = null)}>
    {#each editing.fields as f (f.column.name)}
      <div class="field">
        <div class="head">
          <span>
            {f.column.name}
            <span class="type">
              {[f.column.type.toLowerCase(), f.column.pk && 'key', f.column.notNull && 'required', f.column.generated && 'generated']
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {#if canEdit && !f.column.generated}
            <Checkbox label="NULL" bind:checked={f.isNull} onchange={() => (f.touched = true)} />
          {/if}
        </div>
        {#if isBlob(f.original) && !f.isNull}
          <p class="mono-block muted">blob, {bytes(f.original.blob)}</p>
        {:else}
          <textarea
            class="textarea value"
            rows="1"
            spellcheck="false"
            disabled={f.isNull || locked(f)}
            placeholder={hint(f)}
            bind:value={f.text}
            oninput={() => (f.touched = true)}
          ></textarea>
        {/if}
        {#if isPreview(f.original)}
          <span class="hint">shows the first {f.original.text.length.toLocaleString()} of {f.original.length.toLocaleString()} characters</span>
        {/if}
      </div>
    {/each}
    {#snippet footer()}
      {#if canEdit}
        <button type="button" class="btn strong" onclick={apply}>{editing?.isNew ? 'Add row' : 'Apply'}</button>
      {/if}
      <button type="button" class="btn" onclick={() => (editing = null)}>{canEdit ? 'Cancel' : 'Close'}</button>
      {#if canEdit && editing?.key}
        <button type="button" class="btn danger end" onclick={() => removeRow($state.snapshot(editing?.key ?? null) as DbKey | null)}>
          Delete row
        </button>
      {/if}
    {/snippet}
  </Drawer>
{/if}

<style>
  .db {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .side {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 1px;
    width: 220px;
    padding: 8px 6px;
    border-right: 1px solid var(--border-weak);
    overflow-y: auto;
  }
  .item {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .item:hover {
    background: var(--bg-weak);
  }
  .item.here {
    background: var(--bg-selected);
    color: var(--text-strong);
  }
  .item :global(.icon) {
    flex: none;
    color: var(--icon);
  }
  .item .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    color: var(--text-weaker);
    font-size: 11px;
  }
  .group {
    margin: 12px 8px 4px;
    color: var(--text-weak);
    font-size: 11px;
  }
  .main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .banner {
    padding: 8px 14px;
    border-bottom: 1px solid var(--border-weak);
    background: var(--bg-weak);
    color: var(--warning);
    font-size: 12px;
  }
  .pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }
  .bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 10px 0 14px;
    border-bottom: 1px solid var(--border-weak);
    font-size: 12px;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    color: var(--text-strong);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .filter {
    width: 200px;
    min-width: 80px;
    height: 26px;
    margin-left: auto;
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
  .filter:focus {
    border-color: var(--border);
  }
  .pager {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
    color: var(--text-weak);
    white-space: nowrap;
  }
  .grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-size: 12px;
    outline: none;
  }
  table {
    min-width: 100%;
    border-collapse: separate;
    border-spacing: 0;
  }
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0;
    border-bottom: 1px solid var(--border-weak);
    background: var(--bg-weak);
    font-weight: 400;
    text-align: left;
  }
  th + th,
  td + td {
    border-left: 1px solid var(--border-weak);
  }
  th button,
  .head {
    display: block;
    width: 100%;
    padding: 5px 10px;
    border: 0;
    background: none;
    color: var(--text-weak);
    font: inherit;
    font-size: 11px;
    text-align: left;
    white-space: nowrap;
  }
  th button {
    cursor: pointer;
  }
  th button:hover {
    color: var(--text-strong);
  }
  td {
    max-width: 360px;
    height: 26px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border-weak);
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }
  tr:hover td {
    background: var(--bg-weak);
  }
  tr.picked td {
    background: var(--bg-selected);
    color: var(--text-strong);
  }
  .grid:focus tr.picked td:first-child {
    box-shadow: inset 2px 0 0 var(--focus);
  }
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  td.null {
    color: var(--text-weaker);
    font-style: italic;
  }
  td.blob {
    color: var(--text-weak);
  }
  .editor {
    flex: 0 0 38%;
    min-height: 80px;
    border-bottom: 1px solid var(--border-weak);
    overflow: hidden;
  }
  .editor :global(.cm-editor) {
    height: 100%;
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 20px;
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 85%, transparent);
    font-size: 13px;
  }
  footer {
    display: flex;
    flex: none;
    align-items: center;
    gap: 16px;
    height: 34px;
    padding: 0 8px 0 14px;
    border-top: 1px solid var(--border-weak);
    background: var(--bg-weak);
    color: var(--text-weak);
    font-size: 12px;
    white-space: nowrap;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
  }
  footer .btn {
    flex: none;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-weak);
    font-size: 12px;
  }
  .type {
    margin-left: 6px;
    color: var(--text-weaker);
  }
  .value {
    min-height: 32px;
    max-height: 240px;
    field-sizing: content;
    resize: none;
  }
  .end {
    margin-left: auto;
  }
</style>
