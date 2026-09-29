<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import { Unicode11Addon } from '@xterm/addon-unicode11'
  import { WebglAddon } from '@xterm/addon-webgl'
  import { SearchAddon } from '@xterm/addon-search'
  import { ClipboardAddon } from '@xterm/addon-clipboard'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import X from '@lucide/svelte/icons/x'
  import { app, type Tab } from '$lib/state.svelte'
  import { onSessionData, registerTerminal } from '$lib/sessions'
  import { SEARCH_DECORATIONS, terminalIsDark, terminalTheme } from '$lib/theme'
  import { focusOnMount } from '$lib/focus'
  import { Reconnector } from '$lib/reconnect.svelte'

  let { tab, active }: { tab: Tab; active: boolean } = $props()

  let el = $state<HTMLDivElement>()
  let term: Terminal | undefined
  let fit: FitAddon | undefined
  let search: SearchAddon | undefined
  let fitFrame = 0

  let zoom = $state(0)
  let searchOpen = $state(false)
  let query = $state('')
  let results = $state({ index: -1, count: 0 })
  const reconnect = new Reconnector(() => connect())
  const retry = $derived(reconnect.state)

  const live = $derived(tab.status === 'connected')
  const ended = $derived(tab.status === 'closed' || tab.status === 'error')
  const hostId = $derived('hostId' in tab.target ? tab.target.hostId : '')
  const colors = $derived(terminalTheme(app.settings.terminalTheme, app.theme))
  const decorations = $derived(SEARCH_DECORATIONS[terminalIsDark(app.settings.terminalTheme, app.theme) ? 'dark' : 'light'])

  function refit(): void {
    cancelAnimationFrame(fitFrame)
    fitFrame = requestAnimationFrame(() => {
      if (!term || !fit || !el?.offsetParent) return
      fit.fit()
    })
  }

  function connect(): void {
    if (!term) return
    app.updateTab({ sessionId: tab.id, status: 'connecting' })
    window.api.ssh.open(tab.id, $state.snapshot(tab.target), term.cols, term.rows, tab.command).catch(() => {})
  }

  function reconnectNow(): void {
    reconnect.now()
  }

  function copySelection(): boolean {
    const text = term?.getSelection()
    if (!text) return false
    window.api.app.copy(text)
    return true
  }

  async function guardedPaste(text: string): Promise<void> {
    if (!text || !live || !term) return
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
    const risky = /[\r\n]/.test(text) && !term.modes.bracketedPasteMode
    if (risky && app.settings.pasteProtection) {
      const preview = lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… ${lines.length - 8} more lines` : '')
      const ok = await app.ask({
        title: 'Paste multiple lines?',
        message: `This paste has ${lines.length} line${lines.length > 1 ? 's' : ''} and the shell may run ${lines.length > 1 ? 'them' : 'it'} immediately.`,
        detail: preview,
        fields: [],
        confirmLabel: 'Paste'
      })
      if (!ok) {
        term.focus()
        return
      }
    }
    term.paste(text)
    term.focus()
  }

  async function pasteClipboard(): Promise<void> {
    await guardedPaste(await navigator.clipboard.readText())
  }

  function find(forward = true, incremental = false): void {
    if (!search) return
    if (!query) {
      search.clearDecorations()
      results = { index: -1, count: 0 }
      return
    }
    const options = { decorations, incremental }
    if (forward) search.findNext(query, options)
    else search.findPrevious(query, options)
  }

  function closeSearch(): void {
    searchOpen = false
    search?.clearDecorations()
    term?.focus()
  }

  function notifyBell(): void {
    if (active && document.hasFocus()) return
    app.ringBell(tab.id)
    if (!app.settings.bellNotify || document.hasFocus()) return
    const note = new Notification('bawkterm', { body: `${tab.title} rang the bell` })
    note.onclick = () => {
      window.api.win.focus()
      app.active = tab.id
    }
  }

  onMount(() => {
    const s = app.settings
    const t = new Terminal({
      fontFamily: s.terminalFontFamily,
      fontSize: s.terminalFontSize,
      lineHeight: s.terminalLineHeight,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      theme: colors,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true
    })
    term = t
    fit = new FitAddon()
    search = new SearchAddon()
    t.loadAddon(fit)
    t.loadAddon(search)
    t.loadAddon(new WebLinksAddon((e, uri) => (e.ctrlKey || e.metaKey) && window.api.app.openExternal(uri)))
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
    if (s.osc52) {
      // remote programs may set the local clipboard, never read it, and only from the tab in front
      const writeText = (_sel: unknown, text: string): void => {
        if (!active || !document.hasFocus()) return
        window.api.app.copy(text)
        app.toast(`${tab.title} copied text to your clipboard`)
      }
      t.loadAddon(new ClipboardAddon(undefined, { readText: () => '', writeText }))
    }
    t.open(el!)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      t.loadAddon(webgl)
    } catch {
      // DOM renderer stays active when WebGL is unavailable
    }
    fit.fit()

    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const key = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && key === 'c') {
        copySelection()
        return false
      }
      if (e.ctrlKey && e.shiftKey && key === 'v') {
        // the browser still fires a paste event for this, handled by onPaste
        return false
      }
      if (e.ctrlKey && e.shiftKey && key === 'f') {
        searchOpen = true
        return false
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (key === '=' || key === '+' || key === '-' || key === '0')) {
        zoom = key === '0' ? 0 : Math.max(-6, Math.min(16, zoom + (key === '-' ? -1 : 1)))
        return false
      }
      if (ended && !e.ctrlKey && !e.altKey && (key === 'r' || key === 'enter')) {
        reconnectNow()
        return false
      }
      return true
    })

    const disposables = [
      t.onData((data) => live && window.api.ssh.write(tab.id, data)),
      t.onResize(({ cols, rows }) => window.api.ssh.resize(tab.id, cols, rows)),
      t.onSelectionChange(() => {
        if (app.settings.copyOnSelect) copySelection()
      }),
      t.onBell(notifyBell),
      search.onDidChangeResults(({ resultIndex, resultCount }) => (results = { index: resultIndex, count: resultCount }))
    ]
    const stopData = onSessionData(tab.id, (data) => {
      t.write(data, () => window.api.ssh.ack(tab.id, data.length))
    })
    const unregister = registerTerminal(tab.id, {
      paste: (text) => void guardedPaste(text),
      run: (text) => {
        if (!live) return
        t.paste(text)
        window.api.ssh.write(tab.id, '\r')
        t.focus()
      }
    })
    const observer = new ResizeObserver(refit)
    observer.observe(el!)

    const onContextMenu = (e: MouseEvent): void => {
      if (!app.settings.rightClickPaste) return
      e.preventDefault()
      if (copySelection()) t.clearSelection()
      else void pasteClipboard()
    }
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      void guardedPaste(e.clipboardData?.getData('text/plain') ?? '')
    }
    el!.addEventListener('contextmenu', onContextMenu)
    el!.addEventListener('paste', onPaste, true)

    connect()

    return () => {
      cancelAnimationFrame(fitFrame)
      reconnect.dispose()
      el?.removeEventListener('contextmenu', onContextMenu)
      el?.removeEventListener('paste', onPaste, true)
      observer.disconnect()
      unregister()
      stopData()
      for (const d of disposables) d.dispose()
      t.dispose()
      void window.api.ssh.close(tab.id)
    }
  })

  $effect(() => {
    void decorations
    untrack(() => {
      if (!searchOpen || !query) return
      search?.clearDecorations()
      find(true, true)
    })
  })

  $effect(() => {
    const s = app.settings
    if (!term) return
    term.options.theme = colors
    term.options.fontFamily = s.terminalFontFamily
    term.options.fontSize = Math.max(8, s.terminalFontSize + zoom)
    term.options.lineHeight = s.terminalLineHeight
    term.options.cursorStyle = s.cursorStyle
    term.options.cursorBlink = s.cursorBlink
    term.options.scrollback = s.scrollback
    refit()
  })

  $effect(() => {
    if (!active || !term) return
    app.clearBell(tab.id)
    refit()
    term.focus()
  })

  $effect(() => {
    if (tab.status === 'connected' && active && !searchOpen && !app.modals.length && !app.paletteOpen) term?.focus()
  })

  let lastStatus: string | undefined
  $effect(() => {
    const status = tab.status
    if (!term || status === lastStatus) return
    const previous = lastStatus
    lastStatus = status
    const again = reconnect.track(status, tab.dropped, tab.message, app.settings.autoReconnect)
    if (previous === 'connected' && status === 'closed') {
      term.write(`\r\n\x1b[2m── ${tab.message ?? 'disconnected'}${again ? ' · reconnecting' : ' · press r to reconnect'} ──\x1b[0m\r\n`)
    }
  })
</script>

<div class="terminal-view" style:background={colors.background}>
  <div class="xterm-host" bind:this={el}></div>

  {#if searchOpen}
    <div class="search">
      <input
        bind:value={query}
        placeholder="find"
        spellcheck="false"
        oninput={() => find(true, true)}
        onkeydown={(e) => {
          if (e.key === 'Enter') find(!e.shiftKey)
          else if (e.key === 'Escape') closeSearch()
        }}
        {@attach focusOnMount()}
      />
      <span class="count">{results.count ? `${results.index + 1}/${results.count}` : query ? '0/0' : ''}</span>
      <button type="button" class="btn small icon ghost" aria-label="Previous match" onclick={() => find(false)}><ChevronUp /></button>
      <button type="button" class="btn small icon ghost" aria-label="Next match" onclick={() => find(true)}><ChevronDown /></button>
      <button type="button" class="btn small icon ghost" aria-label="Close search" onclick={closeSearch}><X /></button>
    </div>
  {/if}

  {#if zoom !== 0}
    <button type="button" class="zoom" title="Reset zoom (Ctrl+0)" onclick={() => (zoom = 0)}>
      {zoom > 0 ? '+' : ''}{zoom}pt
    </button>
  {/if}

  {#if tab.status === 'connecting' && !retry}
    <div class="overlay">
      <div class="panel">
        <p class="strong"><span class="dot connecting"></span> connecting to {tab.title}</p>
        <p class="muted">{tab.message ?? 'opening connection…'}</p>
        <button type="button" class="btn small" onclick={() => app.closeTab(tab.id)}>Cancel</button>
      </div>
    </div>
  {:else if retry}
    <div class="bar">
      <span class="muted">
        <span class="dot connecting"></span>
        {tab.status === 'connecting' ? `reconnecting (attempt ${retry?.attempt})…` : `connection lost · retrying in ${retry?.seconds}s (attempt ${retry?.attempt})`}
      </span>
      <button type="button" class="btn small" onclick={reconnectNow}>Retry now</button>
      <button type="button" class="btn small ghost" onclick={() => reconnect.stop()}>Stop</button>
    </div>
  {:else if !live && tab.status === 'error'}
    <div class="overlay">
      <div class="panel error">
        <p class="strong"><span class="dot error"></span> could not connect to {tab.title}</p>
        <p class="message selectable">{tab.message}</p>
        <div class="actions">
          <button type="button" class="btn small strong" onclick={reconnectNow}>Reconnect</button>
          {#if hostId}
            <button
              type="button"
              class="btn small"
              onclick={() => {
                app.active = 'home'
                app.section = 'hosts'
                app.editingHost = hostId
              }}>Edit host</button
            >
          {/if}
          <button type="button" class="btn small ghost" onclick={() => app.closeTab(tab.id)}>Close tab</button>
        </div>
      </div>
    </div>
  {:else if tab.status === 'closed'}
    <div class="bar">
      <span class="muted">[x] {tab.message ?? 'session closed'}</span>
      <button type="button" class="btn small" onclick={reconnectNow}>Reconnect <span class="kbd">r</span></button>
      <button type="button" class="btn small ghost" onclick={() => app.closeTab(tab.id)}>Close tab</button>
    </div>
  {/if}
</div>

<style>
  .terminal-view {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .xterm-host {
    flex: 1;
    min-height: 0;
    padding: 8px 4px 4px 12px;
  }
  .xterm-host :global(.xterm) {
    height: 100%;
  }
  .xterm-host :global(.xterm-viewport) {
    background: transparent !important;
  }
  .search {
    position: absolute;
    top: 8px;
    right: 18px;
    z-index: 12;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 4px 4px 10px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg);
    box-shadow: var(--shadow);
  }
  .search input {
    width: 200px;
    border: 0;
    background: none;
    color: var(--text-strong);
    font: inherit;
    outline: none;
  }
  .count {
    min-width: 48px;
    color: var(--text-weak);
    font-size: 12px;
    text-align: right;
  }
  .zoom {
    position: absolute;
    right: 18px;
    bottom: 10px;
    z-index: 11;
    padding: 2px 8px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text-weak);
    font-size: 11px;
    cursor: pointer;
  }
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 88%, transparent);
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    width: min(520px, calc(100% - 48px));
    padding: 20px 24px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg);
  }
  .panel.error {
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .panel p {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .message {
    color: var(--text);
    line-height: 1.6;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-top: 1px solid var(--border-weak);
    background: var(--bg-weak);
  }
  .bar > span:first-child {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
  }
</style>
