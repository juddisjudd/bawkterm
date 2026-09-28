<script lang="ts">
  import { onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import { WebLinksAddon } from '@xterm/addon-web-links'
  import { Unicode11Addon } from '@xterm/addon-unicode11'
  import { WebglAddon } from '@xterm/addon-webgl'
  import { app, type Tab } from '$lib/state.svelte'
  import { onSessionData, registerTerminal } from '$lib/sessions'
  import { terminalThemes } from '$lib/theme'

  let { tab, active }: { tab: Tab; active: boolean } = $props()

  let el = $state<HTMLDivElement>()
  let term: Terminal | undefined
  let fit: FitAddon | undefined
  let fitFrame = 0

  const live = $derived(tab.status === 'connected')
  const ended = $derived(tab.status === 'closed' || tab.status === 'error')
  const hostId = $derived('hostId' in tab.target ? tab.target.hostId : '')

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
    window.api.ssh.open(tab.id, $state.snapshot(tab.target), term.cols, term.rows).catch(() => {})
  }

  async function paste(): Promise<void> {
    const text = await navigator.clipboard.readText()
    if (text && live) term?.paste(text)
  }

  function copySelection(): boolean {
    const text = term?.getSelection()
    if (!text) return false
    void navigator.clipboard.writeText(text)
    return true
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
      theme: terminalThemes[app.theme],
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true
    })
    term = t
    fit = new FitAddon()
    t.loadAddon(fit)
    t.loadAddon(new WebLinksAddon((_e, uri) => window.api.app.openExternal(uri)))
    t.loadAddon(new Unicode11Addon())
    t.unicode.activeVersion = '11'
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
        void paste()
        return false
      }
      if (ended && (key === 'r' || key === 'enter') && !e.ctrlKey && !e.altKey) {
        connect()
        return false
      }
      return true
    })

    const disposables = [
      t.onData((data) => live && window.api.ssh.write(tab.id, data)),
      t.onResize(({ cols, rows }) => window.api.ssh.resize(tab.id, cols, rows)),
      t.onSelectionChange(() => {
        if (app.settings.copyOnSelect) copySelection()
      })
    ]
    const stopData = onSessionData(tab.id, (data) => t.write(data, () => window.api.ssh.ack(tab.id, data.length)))
    const unregister = registerTerminal(tab.id, {
      paste: (text) => {
        if (live) t.paste(text)
        t.focus()
      },
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
      if (!copySelection()) void paste()
      else t.clearSelection()
    }
    el!.addEventListener('contextmenu', onContextMenu)

    connect()

    return () => {
      cancelAnimationFrame(fitFrame)
      el?.removeEventListener('contextmenu', onContextMenu)
      observer.disconnect()
      unregister()
      stopData()
      for (const d of disposables) d.dispose()
      t.dispose()
      void window.api.ssh.close(tab.id)
    }
  })

  $effect(() => {
    const s = app.settings
    if (!term) return
    term.options.theme = terminalThemes[app.theme]
    term.options.fontFamily = s.terminalFontFamily
    term.options.fontSize = s.terminalFontSize
    term.options.lineHeight = s.terminalLineHeight
    term.options.cursorStyle = s.cursorStyle
    term.options.cursorBlink = s.cursorBlink
    term.options.scrollback = s.scrollback
    refit()
  })

  $effect(() => {
    if (!active || !term) return
    refit()
    term.focus()
  })

  $effect(() => {
    if (tab.status === 'connected' && active && !app.modals.length && !app.paletteOpen) term?.focus()
  })

  let lastStatus: string | undefined
  $effect(() => {
    const status = tab.status
    if (!term || status === lastStatus) return
    const previous = lastStatus
    lastStatus = status
    if (previous === 'connected' && (status === 'closed' || status === 'error')) {
      term.write(`\r\n\x1b[2m── ${tab.message ?? 'disconnected'} · press r to reconnect ──\x1b[0m\r\n`)
    }
  })
</script>

<div class="terminal-view">
  <div class="xterm-host" bind:this={el}></div>

  {#if tab.status === 'connecting'}
    <div class="overlay">
      <div class="panel">
        <p class="strong"><span class="dot connecting"></span> connecting to {tab.title}</p>
        <p class="muted">{tab.message ?? 'opening connection…'}</p>
        <button type="button" class="btn small" onclick={() => app.closeTab(tab.id)}>Cancel</button>
      </div>
    </div>
  {:else if !live && tab.status === 'error'}
    <div class="overlay">
      <div class="panel error">
        <p class="strong"><span class="dot error"></span> could not connect to {tab.title}</p>
        <p class="message selectable">{tab.message}</p>
        <div class="actions">
          <button type="button" class="btn small strong" onclick={connect}>Reconnect</button>
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
      <button type="button" class="btn small" onclick={connect}>Reconnect <span class="kbd">r</span></button>
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
    background: var(--bg);
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
  .bar span:first-child {
    flex: 1;
  }
</style>
