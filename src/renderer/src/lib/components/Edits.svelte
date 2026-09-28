<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import type { EditInfo } from '@shared/types'
  import { app } from '$lib/state.svelte'

  let { sessionId }: { sessionId: string } = $props()

  const list = $derived(app.edits.filter((e) => e.sessionId === sessionId))

  function time(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  function describe(e: EditInfo): string {
    switch (e.state) {
      case 'open':
        return 'open in editor — saves upload automatically'
      case 'uploading':
        return 'uploading…'
      case 'uploaded':
        return `uploaded ${time(e.at)}`
      case 'error':
        return e.message ?? 'upload failed'
      case 'closed':
        return 'closed'
    }
  }
</script>

{#if list.length}
  <section class="edits">
    {#each list as e (e.remotePath)}
      <div class={['edit', e.state]}>
        <span class="mark">✎</span>
        <span class="name" title={e.remotePath}>{e.name}</span>
        <span class="state">{describe(e)}</span>
        <button type="button" class="btn small ghost" onclick={() => window.api.sftp.edit(sessionId, e.remotePath).catch((err) => app.fail(err))}>
          reopen
        </button>
        <button
          type="button"
          class="btn small icon ghost"
          aria-label="Stop editing"
          title="Stop watching this file"
          onclick={() => window.api.sftp.editStop(sessionId, e.remotePath)}><X /></button
        >
      </div>
    {/each}
  </section>
{/if}

<style>
  .edits {
    flex: none;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    padding: 4px 0;
  }
  .edit {
    display: grid;
    grid-template-columns: 16px minmax(80px, 240px) 1fr auto auto;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 8px 0 12px;
    font-size: 12px;
  }
  .mark {
    color: var(--text-weak);
  }
  .name {
    overflow: hidden;
    color: var(--text-strong);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state {
    overflow: hidden;
    color: var(--text-weak);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .uploaded .state {
    color: var(--success);
  }
  .error .state {
    color: var(--danger);
  }
</style>
