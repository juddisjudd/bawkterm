<script lang="ts">
  import type { Snippet } from 'svelte'
  import X from '@lucide/svelte/icons/x'

  let {
    title,
    onclose,
    children,
    footer
  }: { title: string; onclose: () => void; children: Snippet; footer?: Snippet } = $props()
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && !document.querySelector('.backdrop') && onclose()} />

<div class="scrim" role="presentation" onmousedown={onclose}></div>
<aside class="drawer" aria-label={title}>
  <header>
    <h2>{title}</h2>
    <button type="button" class="btn ghost icon" aria-label="Close" onclick={onclose}><X /></button>
  </header>
  <div class="body">
    {@render children()}
  </div>
  {#if footer}
    <footer>{@render footer()}</footer>
  {/if}
</aside>

<style>
  .scrim {
    position: fixed;
    inset: var(--titlebar) 0 0 0;
    z-index: 40;
    background: oklch(0 0 0 / 0.3);
  }
  .drawer {
    position: fixed;
    top: var(--titlebar);
    right: 0;
    bottom: 0;
    z-index: 41;
    display: flex;
    flex-direction: column;
    width: min(460px, 100vw);
    border-left: 1px solid var(--border-weak);
    background: var(--bg);
    box-shadow: var(--shadow);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 14px 24px;
    border-bottom: 1px solid var(--border-weak);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    flex: 1;
    padding: 20px 24px;
    overflow-y: auto;
  }
  footer {
    display: flex;
    gap: 8px;
    padding: 14px 24px;
    border-top: 1px solid var(--border-weak);
  }
</style>
