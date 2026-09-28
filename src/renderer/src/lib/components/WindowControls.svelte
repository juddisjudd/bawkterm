<script lang="ts">
  import { onMount } from 'svelte'

  let maximized = $state(false)

  onMount(() => {
    void window.api.win.isMaximized().then((m) => (maximized = m))
    return window.api.win.onMaximized((m) => (maximized = m))
  })
</script>

<div class="controls">
  <button type="button" class="min" aria-label="Minimize" title="Minimize" onclick={() => window.api.win.minimize()}>
    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7" /></svg>
  </button>
  <button
    type="button"
    class="max"
    aria-label={maximized ? 'Restore' : 'Maximize'}
    title={maximized ? 'Restore' : 'Maximize'}
    onclick={() => window.api.win.toggleMaximize()}
  >
    {#if maximized}
      <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="3.5" width="5" height="5" /><path d="M3.5 3.5v-2h5v5h-2" /></svg>
    {:else}
      <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" /></svg>
    {/if}
  </button>
  <button type="button" class="close" aria-label="Close" title="Close" onclick={() => window.api.win.close()}>
    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.75 1.75l6.5 6.5M8.25 1.75l-6.5 6.5" /></svg>
  </button>
</div>

<style>
  .controls {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 300;
    display: flex;
    height: var(--titlebar);
    padding-right: 6px;
    -webkit-app-region: no-drag;
  }
  button {
    display: grid;
    place-items: center;
    width: 38px;
    border: 0;
    background: none;
    color: var(--text-weak);
    cursor: pointer;
    transition: color 0.12s ease;
  }
  svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .min:hover,
  .min:focus-visible {
    color: var(--warning);
  }
  .max:hover,
  .max:focus-visible {
    color: var(--success);
  }
  .close:hover,
  .close:focus-visible {
    color: var(--danger);
  }
</style>
