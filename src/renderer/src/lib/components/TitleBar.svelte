<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import Plus from '@lucide/svelte/icons/plus'
  import { app, type Tab } from '$lib/state.svelte'
  import Logo from './Logo.svelte'

  function onauxclick(e: MouseEvent, tab: Tab): void {
    if (e.button === 1) app.closeTab(tab.id)
  }
</script>

<header class="bar">
  <div class="brand"><Logo /></div>
  <nav class="tabs">
    <button type="button" class={['tab', 'home', app.active === 'home' && 'active']} onclick={() => (app.active = 'home')}>
      vault
    </button>
    {#each app.tabs as tab (tab.id)}
      <div
        class={['tab', app.active === tab.id && 'active']}
        role="tab"
        tabindex="0"
        aria-selected={app.active === tab.id}
        title={tab.message ? `${tab.title} — ${tab.message}` : tab.title}
        onclick={() => (app.active = tab.id)}
        onkeydown={(e) => e.key === 'Enter' && (app.active = tab.id)}
        onauxclick={(e) => onauxclick(e, tab)}
      >
        <span class={['dot', tab.status]}></span>
        <span class="kind">{tab.kind}</span>
        <span class="title">{tab.title}</span>
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
      title="Open host (Ctrl+Shift+P)"
      onclick={() => app.openPalette()}><Plus size={15} /></button
    >
  </nav>
</header>

<style>
  .bar {
    display: flex;
    align-items: stretch;
    height: var(--titlebar);
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
  .home {
    padding-right: 14px;
  }
  .kind {
    color: var(--text-weaker);
    font-size: 11px;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
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
