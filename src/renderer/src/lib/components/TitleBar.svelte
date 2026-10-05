<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import Plus from '@lucide/svelte/icons/plus'
  import { FOLDER_COLORS } from '@shared/defaults'
  import { app, tabName, type MenuItem, type Tab } from '$lib/state.svelte'
  import { tint } from '$lib/folders'
  import { MOD } from '$lib/keys'
  import Logo from './Logo.svelte'

  let strip = $state<HTMLElement>()

  $effect(() => {
    const id = app.active
    void app.tabs.length
    strip?.querySelector(`[data-tab="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })

  function onauxclick(e: MouseEvent, tab: Tab): void {
    if (e.button === 1) app.closeTab(tab.id)
  }

  function onkeydown(e: KeyboardEvent, tab: Tab): void {
    if (e.key === 'Enter') app.active = tab.id
    else if (e.key === 'F2') void app.renameTab(tab.id)
  }

  function tooltip(tab: Tab): string {
    const name = tab.label ? `${tab.label} (${tab.title})` : tab.title
    return tab.message ? `${name} — ${tab.message}` : name
  }

  function menu(e: MouseEvent, tab: Tab): void {
    const target = $state.snapshot(tab.target)
    const host = 'hostId' in target ? app.vault?.hosts.find((h) => h.id === target.hostId) : undefined
    const name = host?.label || host?.address || tab.title
    const open: MenuItem[] = []
    if (tab.kind === 'ssh') {
      const look = { label: tab.label, color: tab.color }
      open.push({ label: 'Duplicate tab', action: () => app.openTab('ssh', target, tab.title, tab.command, look) })
    }
    if (tab.kind !== 'ssh' || tab.command) open.push({ label: 'Open terminal', action: () => app.openTab('ssh', target, name) })
    if (tab.kind !== 'sftp') open.push({ label: 'Open SFTP', action: () => app.openTab('sftp', target, name) })
    if (tab.kind !== 'docker') open.push({ label: 'Open Docker', action: () => app.openTab('docker', target, name) })
    app.openMenu(e, [
      ...open,
      'sep',
      { label: 'Rename tab', action: () => app.renameTab(tab.id) },
      { swatches: FOLDER_COLORS, current: tab.color ?? null, pick: (color) => app.colorTab(tab.id, color) },
      'sep',
      { label: 'Close tab', action: () => app.closeTab(tab.id) },
      { label: 'Close other tabs', action: () => app.closeOtherTabs(tab.id), disabled: app.tabs.length < 2 }
    ])
  }
</script>

<header class="bar">
  <div class="brand"><Logo /></div>
  <nav class="tabs" bind:this={strip}>
    <button type="button" class={['tab', 'home', app.active === 'home' && 'active']} onclick={() => (app.active = 'home')}>
      vault
    </button>
    {#each app.tabs as tab (tab.id)}
      <div
        class={['tab', app.active === tab.id && 'active', tab.color && 'colored']}
        style:--tab-color={tint(tab.color)}
        data-tab={tab.id}
        role="tab"
        tabindex="0"
        aria-selected={app.active === tab.id}
        title={tooltip(tab)}
        onclick={() => (app.active = tab.id)}
        ondblclick={() => app.renameTab(tab.id)}
        onkeydown={(e) => onkeydown(e, tab)}
        onauxclick={(e) => onauxclick(e, tab)}
        oncontextmenu={(e) => menu(e, tab)}
      >
        <span class="kind">{tab.kind}</span>
        {#if tab.status !== 'connected'}<span class={['dot', tab.status]} title={tab.status}></span>{/if}
        <span class="title">{tabName(tab)}</span>
        {#if tab.dirty}<span class="dirty" title="unsaved changes">*</span>{/if}
        {#if tab.bell}<span class="bell" title="bell">!</span>{/if}
        <button
          type="button"
          class="close"
          aria-label="Close tab"
          onclick={(e) => {
            e.stopPropagation()
            app.closeTab(tab.id)
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
  .home {
    padding-right: 14px;
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
