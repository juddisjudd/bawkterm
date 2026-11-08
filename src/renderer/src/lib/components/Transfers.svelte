<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import Trash from '@lucide/svelte/icons/trash-2'
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

  function fraction(t: TransferInfo): number {
    const [done, total] = t.direction === 'delete' ? [t.filesDone, t.files] : [t.bytes, t.total]
    return total ? done / total : t.state === 'done' ? 1 : 0
  }

  function amount(t: TransferInfo): string {
    if (t.direction === 'delete') return t.scanning ? `${t.files} found` : `${t.filesDone}/${t.files} items`
    return `${bytes(t.bytes)} / ${bytes(t.total)}${t.files > 1 ? ` · ${t.filesDone}/${t.files} files` : ''}`
  }

  function label(t: TransferInfo): string {
    const deleting = t.direction === 'delete'
    switch (t.state) {
      case 'queued':
        return 'queued'
      case 'active':
        return t.scanning ? 'scanning' : deleting ? 'deleting' : rate(t)
      case 'done':
        return deleting ? 'deleted' : 'done'
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
        {open ? '▾' : '▸'} activity
        <span class="muted">{running ? `${running} running` : 'idle'}</span>
      </button>
      {#if finished}
        <button type="button" class="btn small ghost" onclick={() => app.clearTransfers(sessionId)}>clear finished</button>
      {/if}
    </header>
    {#if open}
      <ul>
        {#each list as t (t.id)}
          {@const done = fraction(t)}
          {@const deleting = t.direction === 'delete'}
          <li class={t.state}>
            <span class="dir">{#if deleting}<Trash size={12} />{:else}{t.direction === 'upload' ? '↑' : '↓'}{/if}</span>
            <span class="name" title={deleting ? t.source : `${t.source} → ${t.dest}`}>{visibleName(t.name)}</span>
            <span class="bar">{bar(done)} {Math.floor(done * 100)}%</span>
            <span class="pct">{Math.floor(done * 100)}%</span>
            <span class="size">{amount(t)}</span>
            <span class="state" title={t.error}>{t.error ?? label(t)}</span>
            {#if t.state === 'active' || t.state === 'queued'}
              <button type="button" class="btn small icon ghost" aria-label={deleting ? 'Cancel delete' : 'Cancel transfer'} onclick={() => window.api.sftp.cancel(t.id)}>
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
    container-type: inline-size;
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
    display: flex;
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
  .pct {
    display: none;
    color: var(--text);
    text-align: right;
  }
  @container (max-width: 600px) {
    li {
      grid-template-columns: 16px minmax(0, 1fr) 36px 72px 24px;
    }
    .bar,
    .size {
      display: none;
    }
    .pct {
      display: block;
    }
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
