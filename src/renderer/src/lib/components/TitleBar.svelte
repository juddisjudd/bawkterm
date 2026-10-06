<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import Plus from '@lucide/svelte/icons/plus'
  import RadioTower from '@lucide/svelte/icons/radio-tower'
  import type { SessionStatus } from '@shared/types'
  import { app, tabName, type StripEntry, type Tab } from '$lib/state.svelte'
  import { tabMenu } from '$lib/tab-menu.svelte'
  import { tint } from '$lib/folders'
  import { MOD } from '$lib/keys'
  import Logo from './Logo.svelte'

  let strip = $state<HTMLElement>()

  const PROBLEMS: SessionStatus[] = ['error', 'closed', 'connecting']

  $effect(() => {
    const key = app.splitOf(app.active)?.id ?? app.active
    void app.tabs.length
    strip?.querySelector(`[data-tab="${key}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })

  function closeEntry(entry: StripEntry): void {
    app.closeTabs(entry.panes.map((t) => t.id))
  }

  function onauxclick(e: MouseEvent, entry: StripEntry): void {
    if (e.button === 1) closeEntry(entry)
  }

  function onkeydown(e: KeyboardEvent, tab: Tab): void {
    if (e.key === 'Enter') app.active = tab.id
    else if (e.key === 'F2') void app.renameTab(tab.id)
  }

  function status(entry: StripEntry): SessionStatus {
    return PROBLEMS.find((s) => entry.panes.some((t) => t.status === s)) ?? 'connected'
  }

  function tooltip(entry: StripEntry): string {
    return entry.panes
      .map((tab) => {
        const name = tab.label ? `${tab.label} (${tab.title})` : tab.title
        return tab.message ? `${name} — ${tab.message}` : name
      })
      .join('\n')
  }
</script>

<header class="bar">
  <div class="brand"><Logo /></div>
  <nav class="tabs" bind:this={strip}>
    <button type="button" class={['tab', 'home', app.active === 'home' && 'active']} onclick={() => (app.active = 'home')}>
      vault
    </button>
    {#each app.strip as entry (entry.key)}
      {@const tab = entry.tab}
      {@const selected = entry.panes.some((t) => t.id === app.active)}
      {@const worst = status(entry)}
      <div
        class={['tab', selected && 'active', tab.color && 'colored', entry.split && 'split']}
        style:--tab-color={tint(tab.color)}
        data-tab={entry.key}
        role="tab"
        tabindex="0"
        aria-selected={selected}
        title={tooltip(entry)}
        onclick={() => (app.active = tab.id)}
        ondblclick={() => app.renameTab(tab.id)}
        onkeydown={(e) => onkeydown(e, tab)}
        onauxclick={(e) => onauxclick(e, entry)}
        oncontextmenu={(e) => app.openMenu(e, tabMenu(tab, 'strip'))}
      >
        <span class="kind">{tab.kind}</span>
        {#if worst !== 'connected'}<span class={['dot', worst]} title={worst}></span>{/if}
        <span class="title">{entry.panes.map(tabName).join(' | ')}</span>
        {#if entry.split?.broadcast}<span class="cast" title="Broadcasting input to all panes"><RadioTower size={13} /></span>{/if}
        {#if entry.panes.some((t) => t.dirty)}<span class="dirty" title="unsaved changes">*</span>{/if}
        {#if entry.panes.some((t) => t.bell)}<span class="bell" title="bell">!</span>{/if}
        <button
          type="button"
          class="close"
          aria-label={entry.split ? 'Close all panes' : 'Close tab'}
          onclick={(e) => {
            e.stopPropagation()
            closeEntry(entry)
          }}><X size={13} /></button
        >
      </div>
    {/each}
    <button
      type="button"
      class="new"
      aria-label="Open host"
      title="Open host ({MOD}+Shift+P)"
      onclick={() => app.openPalette()}><Plus size={15} /></button
    >
  </nav>
</header>

<style>
  .bar {
    display: flex;
    align-items: stretch;
    height: var(--titlebar);
    padding-left: var(--lights-width);
    padding-right: var(--controls-width);
    border-bottom: 1px solid var(--border-weak);
    background: var(--bg);
    -webkit-app-region: drag;
  }
  .brand {
    display: flex;
    align-items: center;
    padding: 0 16px;
  }
  .tabs {
    display: flex;
    align-items: stretch;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 220px;
    padding: 0 10px 0 14px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-weak);
    white-space: nowrap;
    cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    border-bottom-color: var(--bg-strong);
    color: var(--text-strong);
  }
  .tab.colored {
    border-bottom-color: color-mix(in oklch, var(--tab-color) 45%, transparent);
    background: color-mix(in oklch, var(--tab-color) 7%, transparent);
  }
  .tab.colored.active {
    border-bottom-color: var(--tab-color);
    background: color-mix(in oklch, var(--tab-color) 13%, transparent);
  }
  .tab.split {
    max-width: 320px;
  }
  .home {
    padding-right: 14px;
  }
  .cast {
    display: grid;
    color: var(--warning);
  }
  .kind {
    flex: none;
    padding: 0 5px;
    border: 1px solid var(--border-weak);
    border-radius: 3px;
    background: var(--bg-weak);
    color: var(--text-weak);
    font-size: 10px;
    line-height: 16px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .tab.active .kind {
    border-color: var(--border);
    color: var(--text);
  }
  .tab.colored .kind {
    border-color: var(--tab-color);
    color: var(--tab-color);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dirty {
    margin-left: -4px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .bell {
    color: var(--warning);
    font-weight: 600;
  }
  .close {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--text-weak);
    opacity: 0;
    cursor: pointer;
  }
  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }
  .close:hover {
    background: var(--bg-weak-hover);
    color: var(--text-strong);
  }
  .new {
    display: grid;
    place-items: center;
    width: 36px;
    border: 0;
    background: none;
    color: var(--text-weak);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .new:hover {
    color: var(--text-strong);
  }
</style>
