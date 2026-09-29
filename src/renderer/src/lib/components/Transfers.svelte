<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import type { TransferInfo } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import { bar, bytes, visibleName } from '$lib/format'

  let { sessionId }: { sessionId: string } = $props()

  let open = $state(true)
  const list = $derived(app.transfers.filter((t) => t.sessionId === sessionId))
  const running = $derived(list.filter((t) => t.state === 'active' || t.state === 'queued').length)
  const finished = $derived(list.length - running)

  function rate(t: TransferInfo): string {
    const seconds = (Date.now() - t.startedAt) / 1000
    return seconds > 0.5 ? `${bytes(t.bytes / seconds)}/s` : ''
  }

  function label(t: TransferInfo): string {
    switch (t.state) {
      case 'queued':
        return 'queued'
      case 'active':
        return rate(t)
      case 'done':
        return 'done'
      case 'cancelled':
        return 'cancelled'
      case 'error':
        return 'failed'
      case 'skipped':
        return 'skipped (already there)'
    }
  }
</script>

{#if list.length}
  <section class="transfers">
    <header>
      <button type="button" class="toggle" onclick={() => (open = !open)}>
        {open ? '▾' : '▸'} transfers
        <span class="muted">{running ? `${running} running` : 'idle'}</span>
      </button>
      {#if finished}
        <button type="button" class="btn small ghost" onclick={() => app.clearTransfers(sessionId)}>clear finished</button>
      {/if}
    </header>
    {#if open}
      <ul>
        {#each list as t (t.id)}
          {@const fraction = t.total ? t.bytes / t.total : t.state === 'done' ? 1 : 0}
          <li class={t.state}>
            <span class="dir">{t.direction === 'upload' ? '↑' : '↓'}</span>
            <span class="name" title={`${t.source} → ${t.dest}`}>{visibleName(t.name)}</span>
            <span class="bar">{bar(fraction)} {Math.floor(fraction * 100)}%</span>
            <span class="size">{bytes(t.bytes)} / {bytes(t.total)}{t.files > 1 ? ` · ${t.filesDone}/${t.files} files` : ''}</span>
            <span class="state" title={t.error}>{t.error ?? label(t)}</span>
            {#if t.state === 'active' || t.state === 'queued'}
              <button type="button" class="btn small icon ghost" aria-label="Cancel transfer" onclick={() => window.api.sftp.cancel(t.id)}>
                <X />
              </button>
            {:else}
              <span></span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .transfers {
    flex: none;
    max-height: 34%;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px 4px 12px;
    background: var(--bg-weak);
  }
  .toggle {
    display: flex;
    gap: 10px;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--text-strong);
    cursor: pointer;
  }
  ul {
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    list-style: none;
    border-top: 1px solid var(--border-weak);
  }
  li {
    display: grid;
    grid-template-columns: 16px minmax(80px, 1fr) 190px 220px 110px 24px;
    align-items: center;
    gap: 10px;
    height: 28px;
    padding: 0 8px 0 12px;
    font-size: 12px;
  }
  .dir {
    color: var(--text-weak);
  }
  .name {
    overflow: hidden;
    color: var(--text-strong);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar {
    color: var(--text);
    white-space: pre;
  }
  .size,
  .state {
    overflow: hidden;
    color: var(--text-weak);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li.done .bar {
    color: var(--success);
  }
  li.error .state,
  li.error .bar {
    color: var(--danger);
  }
  li.cancelled,
  li.skipped {
    opacity: 0.6;
  }
</style>
