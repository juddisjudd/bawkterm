<script lang="ts">
  import type { AdhocTarget, Host, LocalShell, Snippet } from '@shared/types'
  import { app, type Section } from '$lib/state.svelte'
  import { focusOnMount } from '$lib/focus'
  import { terminalFor } from '$lib/sessions'
  import { tint } from '$lib/folders'
  import { MOD, mod } from '$lib/keys'
  import Folder from '@lucide/svelte/icons/folder'

  type Item =
    | { kind: 'host'; host: Host }
    | { kind: 'shell'; shell: LocalShell }
    | { kind: 'folder'; host: Host; path: string }
    | { kind: 'adhoc'; target: AdhocTarget }
    | { kind: 'snippet'; snippet: Snippet }
    | { kind: 'command'; label: string; run: () => void }

  let query = $state('')
  let index = $state(0)

  const goto = (section: Section) => () => {
    app.active = 'home'
    app.section = section
  }

  const commands: Item[] = [
    {
      kind: 'command',
      label: 'new host',
      run: () => {
        goto('hosts')()
        app.editingHost = ''
      }
    },
    { kind: 'command', label: 'open keychain', run: goto('keychain') },
    { kind: 'command', label: 'open snippets', run: goto('snippets') },
    { kind: 'command', label: 'open known hosts', run: goto('known') },
    { kind: 'command', label: 'open settings', run: goto('settings') },
    { kind: 'command', label: 'lock vault', run: () => void app.lock() }
  ]

  function parseTarget(text: string): AdhocTarget | null {
    const m = text.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([\w.-]+|\[[0-9a-fA-F:]+\])(?::(\d+))?(?:\s+-p\s*(\d+))?$/)
    if (!m || !(m[1] || m[2].includes('.') || m[2].startsWith('['))) return null
    const port = Number(m[4] ?? m[3] ?? 22)
    if (port < 1 || port > 65535) return null
    return { username: m[1] ?? '', address: m[2].replace(/^\[|\]$/g, ''), port }
  }

  const terminalTab = $derived(app.tabs.find((t) => t.id === app.active && t.kind === 'ssh'))
  const snippetMode = $derived(app.paletteMode === 'snippets')

  const items = $derived.by((): Item[] => {
    const q = query.trim().toLowerCase()
    const snippets = (snippetMode || terminalTab ? (app.vault?.snippets ?? []) : [])
      .filter((s) => !q || s.label.toLowerCase().includes(q) || s.command.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((snippet): Item => ({ kind: 'snippet', snippet }))
    if (snippetMode) return snippets
    const hosts = [...(app.vault?.hosts ?? [])]
      .filter((h) =>
        !q
          ? true
          : [h.label, h.address, h.username, h.group, ...h.tags].some((v) => v.toLowerCase().includes(q))
      )
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.label.localeCompare(b.label))
      .slice(0, 12)
      .map((host): Item => ({ kind: 'host', host }))
    const folders = !q
      ? []
      : (app.vault?.hosts ?? [])
          .flatMap((host) => host.bookmarks.map((path): Item => ({ kind: 'folder', host, path })))
          .filter(
            (f) =>
              f.kind === 'folder' &&
              [f.path, f.host.label, f.host.address].some((v) => v.toLowerCase().includes(q))
          )
          .slice(0, 8)
    const shells = app.shells
      .filter((s) => !q || s.name.toLowerCase().includes(q) || 'local terminal shell'.includes(q))
      .map((shell): Item => ({ kind: 'shell', shell }))
    const adhoc = parseTarget(query)
    const cmds = commands.filter((c) => c.kind === 'command' && q && c.label.includes(q))
    const lead = adhoc ? [{ kind: 'adhoc', target: adhoc } as Item] : []
    return terminalTab && q
      ? [...lead, ...snippets, ...hosts, ...shells, ...folders, ...cmds]
      : [...lead, ...hosts, ...shells, ...folders, ...snippets, ...cmds]
  })

  const current = $derived(items[index])

  function keyOf(item: Item): string {
    if (item.kind === 'host') return item.host.id
    if (item.kind === 'shell') return `shell:${item.shell.id}`
    if (item.kind === 'folder') return `${item.host.id}:${item.path}`
    if (item.kind === 'snippet') return item.snippet.id
    return item.kind === 'adhoc' ? 'adhoc' : item.label
  }

  function run(item: Item | undefined, shift: boolean, ctrl = false): void {
    if (!item) return
    app.paletteOpen = false
    if (item.kind === 'snippet') {
      const terminal = terminalTab && terminalFor(terminalTab.id)
      if (!terminal) {
        app.toast('Open an SSH tab to run snippets', 'error')
        return
      }
      if (shift) terminal.paste(item.snippet.command)
      else terminal.run(item.snippet.command)
      return
    }
    const place = app.palettePlace
    if (item.kind === 'shell') {
      app.openLocal(item.shell.id, place)
      return
    }
    if (item.kind === 'folder') {
      app.rememberPath(item.host.id, item.path)
      app.openHost('sftp', item.host.id, place)
      return
    }
    const sftp = shift
    const kind = ctrl ? 'docker' : sftp ? 'sftp' : 'ssh'
    if (item.kind === 'host') app.openHost(kind, item.host.id, place)
    else if (item.kind === 'adhoc') {
      const t = item.target
      app.openTab(kind, { adhoc: t }, t.username ? `${t.username}@${t.address}` : t.address, undefined, {}, place)
    } else item.run()
  }

  function onkeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      index = Math.min(index + 1, items.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      index = Math.max(index - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(items[index], e.shiftKey, mod(e))
    } else if (e.key === 'Escape') {
      app.paletteOpen = false
    }
  }
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && (app.paletteOpen = false)}>
  <div class="palette" role="dialog" aria-label="Open host">
    <div class="prompt">
      <span class="caret">&gt;</span>
      <input
        bind:value={query}
        oninput={() => (index = 0)}
        {onkeydown}
        placeholder={snippetMode
          ? 'search snippets'
          : app.palettePlace
            ? 'open in a new pane: search hosts or type user@host:port'
            : 'search hosts or type user@host:port'}
        {@attach focusOnMount()}
        spellcheck="false"
      />
    </div>
    <ul>
      {#each items as item, i (keyOf(item))}
        <li>
          <button
            type="button"
            class:active={i === index}
            onmousemove={() => (index = i)}
            onclick={(e) => run(item, e.shiftKey, mod(e))}
          >
            {#if item.kind === 'host'}
              <span class="name">{item.host.label || item.host.address}</span>
              <span class="meta"
                >{item.host.kind === 'rdp' ? 'rdp · ' : ''}{item.host.username ? `${item.host.username}@` : ''}{item.host.address}</span
              >
            {:else if item.kind === 'shell'}
              <span class="name"><span class="dollar">&gt;_</span> {item.shell.name}</span>
              <span class="meta">local terminal</span>
            {:else if item.kind === 'folder'}
              <span class="name folder" style:--tint={tint(item.host.folderColors[item.path])}
                ><Folder size={13} class="icon" /> {item.path.split('/').filter(Boolean).at(-1) ?? '/'}</span
              >
              <span class="meta">sftp · {item.host.label || item.host.address} · {item.path}</span>
            {:else if item.kind === 'adhoc'}
              <span class="name">connect</span>
              <span class="meta"
                >{item.target.username ? `${item.target.username}@` : ''}{item.target.address}:{item.target
                  .port}</span
              >
            {:else if item.kind === 'snippet'}
              <span class="name"><span class="dollar">$</span> {item.snippet.label}</span>
              <span class="meta">{item.snippet.command.split('\n')[0]}</span>
            {:else}
              <span class="name">{item.label}</span>
              <span class="meta">command</span>
            {/if}
          </button>
        </li>
      {:else}
        <li class="empty">
          {snippetMode && !app.vault?.snippets.length ? 'no snippets yet — add them under vault → snippets' : 'no matches'}
        </li>
      {/each}
    </ul>
    <footer>
      {#if current?.kind === 'folder'}
        <span><span class="kbd">enter</span> open in sftp</span>
      {:else if current?.kind === 'shell'}
        <span><span class="kbd">enter</span> open terminal</span>
      {:else if current?.kind === 'snippet'}
        <span><span class="kbd">enter</span> run</span>
        <span><span class="kbd">shift+enter</span> paste only</span>
      {:else}
        <span><span class="kbd">enter</span> ssh</span>
        <span><span class="kbd">shift+enter</span> sftp</span>
        <span><span class="kbd">{MOD.toLowerCase()}+enter</span> docker</span>
      {/if}
      <span><span class="kbd">esc</span> close</span>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: oklch(0 0 0 / 0.35);
  }
  .palette {
    width: min(620px, calc(100vw - 48px));
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .prompt {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border-weak);
    background: var(--bg-weak);
  }
  .caret {
    color: var(--text-strong);
    font-weight: 600;
  }
  input {
    flex: 1;
    border: 0;
    background: none;
    color: var(--text-strong);
    font: inherit;
    font-size: 14px;
    outline: none;
  }
  input::placeholder {
    color: var(--text-weaker);
  }
  ul {
    max-height: 360px;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    list-style: none;
  }
  li button {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  li button.active {
    background: var(--bg-weak-hover);
  }
  .name {
    flex: none;
    color: var(--text-strong);
  }
  .folder {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .folder :global(.icon) {
    color: var(--tint, var(--icon));
    fill: color-mix(in oklch, var(--tint, transparent) 30%, transparent);
  }
  .dollar {
    color: var(--text-weak);
  }
  .meta {
    overflow: hidden;
    color: var(--text-weak);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    padding: 10px;
    color: var(--text-weak);
  }
  footer {
    display: flex;
    gap: 18px;
    padding: 10px 16px;
    border-top: 1px solid var(--border-weak);
    color: var(--text-weak);
    font-size: 12px;
  }
</style>
