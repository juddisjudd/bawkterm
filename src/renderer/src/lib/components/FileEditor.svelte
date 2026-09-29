<script lang="ts">
  import { onMount } from 'svelte'
  import { Compartment, EditorState } from '@codemirror/state'
  import {
    EditorView,
    crosshairCursor,
    drawSelection,
    dropCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection
  } from '@codemirror/view'
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
  import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
  import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
  import { app, type Tab } from '$lib/state.svelte'
  import { detectLanguage, editorHighlight, editorTheme } from '$lib/editor'

  let { tab, active }: { tab: Tab; active: boolean } = $props()

  const api = window.api
  const path = $derived(tab.edit!.path)
  // svelte-ignore state_referenced_locally
  let sessionId = tab.edit!.sessionId

  let host = $state<HTMLDivElement>()
  let view = $state.raw<EditorView>()
  let file = $state.raw<{ bom: boolean; mtime: number; size: number } | null>(null)
  let savedText = ''
  let phase = $state<'loading' | 'ready' | 'saving' | 'failed'>('loading')
  let error = $state('')
  let dirty = $state(false)
  let language = $state('plain text')
  let crlf = $state(false)
  let cursor = $state({ line: 1, col: 1 })
  let wrap = $state(false)

  const language$ = new Compartment()
  const wrap$ = new Compartment()

  $effect(() => {
    tab.dirty = dirty
  })

  $effect(() => {
    if (active && phase !== 'loading') view?.focus()
  })

  // the SFTP tab's session is reused; if that tab closed, this editor opens its own
  async function withSession<T>(task: (id: string) => Promise<T>): Promise<T> {
    try {
      return await task(sessionId)
    } catch (err) {
      if (!/not connected/.test((err as Error).message)) throw err
      await api.sftp.open(tab.id, $state.snapshot(tab.target))
      sessionId = tab.id
      return task(sessionId)
    }
  }

  function createState(text: string): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter({ openText: '▾', closedText: '▸' }),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (void save(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap
        ]),
        editorTheme,
        editorHighlight,
        language$.of([]),
        wrap$.of(wrap ? EditorView.lineWrapping : []),
        ...(crlf ? [EditorState.lineSeparator.of('\r\n')] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const doc = u.state.doc
            dirty = doc.length !== savedText.length || u.state.sliceDoc() !== savedText
          }
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head
            const line = u.state.doc.lineAt(head)
            cursor = { line: line.number, col: head - line.from + 1 }
          }
        })
      ]
    })
  }

  async function load(): Promise<void> {
    phase = 'loading'
    error = ''
    try {
      const loaded = await withSession((id) => api.sftp.readText(id, path))
      file = { bom: loaded.bom, mtime: loaded.mtime, size: loaded.size }
      crlf = loaded.text.includes('\r\n') && !/(^|[^\r])\n/.test(loaded.text)
      const state = createState(loaded.text)
      savedText = state.sliceDoc()
      dirty = false
      cursor = { line: 1, col: 1 }
      if (view) view.setState(state)
      else view = new EditorView({ state, parent: host })
      phase = 'ready'
      const name = path.split('/').pop() ?? ''
      const desc = detectLanguage(name, loaded.text)
      language = desc?.name ?? 'plain text'
      if (desc) {
        const support = await desc.load()
        view.dispatch({ effects: language$.reconfigure(support) })
      }
      if (active) view.focus()
    } catch (err) {
      phase = 'failed'
      error = (err as Error).message
    }
  }

  async function save(force = false): Promise<void> {
    if (!view || !file || phase !== 'ready') return
    const text = view.state.sliceDoc()
    const current = file
    phase = 'saving'
    try {
      const res = await withSession((id) => api.sftp.writeText(id, path, text, current.bom, force ? null : { mtime: current.mtime, size: current.size }))
      phase = 'ready'
      if (res.conflict) {
        const answer = await app.ask({
          title: 'File changed on the server',
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
        return
      }
      file = { ...current, mtime: res.mtime, size: res.size }
      savedText = text
      dirty = view.state.sliceDoc() !== savedText
    } catch (err) {
      phase = 'ready'
      app.fail(err)
    }
  }

  async function reload(): Promise<void> {
    if (dirty && !(await app.confirm('Reload from server', 'Discard your changes and load the server copy?', 'Discard and reload'))) return
    await load()
  }

  function toggleWrap(): void {
    wrap = !wrap
    view?.dispatch({ effects: wrap$.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }

  onMount(() => {
    void load()
    return () => view?.destroy()
  })
</script>

<div class="editor" style:font-family={app.settings.terminalFontFamily} style:font-size="{app.settings.terminalFontSize}px">
  <div class="host" bind:this={host} hidden={phase === 'failed'}></div>
  {#if phase === 'loading' && !view}
    <p class="state muted">opening {path}…</p>
  {:else if phase === 'failed'}
    <div class="state">
      <p class="error selectable">{error}</p>
      <div class="actions">
        <button type="button" class="btn small" onclick={load}>Try again</button>
        <button type="button" class="btn small ghost" onclick={() => app.closeTab(tab.id)}>Close tab</button>
      </div>
    </div>
  {/if}
  <footer>
    <span class="path selectable" title={path}>{path}</span>
    <span>{language}</span>
    <span>ln {cursor.line}, col {cursor.col}</span>
    <span>{crlf ? 'CRLF' : 'LF'}{file?.bom ? ' · BOM' : ''}</span>
    <button type="button" class="btn small ghost" aria-pressed={wrap} onclick={toggleWrap}>{wrap ? '[x]' : '[ ]'} wrap</button>
    <button type="button" class="btn small ghost" disabled={phase !== 'ready'} onclick={reload}>Reload</button>
    <button type="button" class="btn small strong" disabled={phase !== 'ready' || !dirty} onclick={() => save()} title="Save (Ctrl+S)">
      {phase === 'saving' ? 'Saving…' : dirty ? 'Save' : 'Saved'}
    </button>
  </footer>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .host {
    flex: 1;
    min-height: 0;
  }
  .host :global(.cm-editor) {
    height: 100%;
  }
  .state {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    padding: 20px;
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  footer {
    display: flex;
    align-items: center;
    gap: 16px;
    height: 34px;
    padding: 0 8px 0 14px;
    border-top: 1px solid var(--border-weak);
    background: var(--bg-weak);
    color: var(--text-weak);
    font-family: var(--font-mono);
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
</style>
