<script lang="ts">
  import { app } from '$lib/state.svelte'
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <div class={['toast', toast.kind]}>
      <span class="mark">{toast.kind === 'error' ? '[!]' : '[*]'}</span>
      <span>{toast.message}</span>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(440px, calc(100vw - 32px));
    pointer-events: none;
  }
  .toast {
    display: flex;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    background: var(--bg-weak);
    color: var(--text-strong);
    box-shadow: var(--shadow);
    user-select: text;
    pointer-events: auto;
  }
  .mark {
    color: var(--text-weak);
    flex: none;
  }
  .error {
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .error .mark {
    color: var(--danger);
  }
</style>
