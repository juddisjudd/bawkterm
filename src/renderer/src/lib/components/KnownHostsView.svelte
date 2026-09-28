<script lang="ts">
  import type { KnownHost } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import { date } from '$lib/format'
  import PageHeader from './PageHeader.svelte'

  const vault = $derived(app.vault!)
  const list = $derived([...vault.knownHosts].sort((a, b) => a.host.localeCompare(b.host)))

  async function remove(k: KnownHost): Promise<void> {
    const ok = await app.confirm(
      'Forget host key',
      `Forget the ${k.keyType} key for ${k.host}? You will be asked to check the fingerprint on the next connection.`,
      'Forget'
    )
    if (ok) await window.api.knownHosts.remove(k.host, k.keyType).catch((err) => app.fail(err))
  }
</script>

<div class="page">
  <PageHeader title="known hosts" subtitle="Server keys you have trusted. A changed key blocks the connection until you approve it." />
  {#if list.length}
    <ul>
      {#each list as k (k.host + k.keyType)}
        <li>
          <span class="host">{k.host}</span>
          <span class="type">{k.keyType}</span>
          <span class="fp selectable">{k.fingerprint}</span>
          <span class="type">{date(k.addedAt)}</span>
          <button type="button" class="btn small ghost danger" onclick={() => remove(k)}>forget</button>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="empty">
      <p class="strong">[ ] nothing trusted yet</p>
      <p class="muted">Keys appear here after you confirm a fingerprint on first connection.</p>
    </div>
  {/if}
</div>

<style>
  .page {
    padding: 32px 40px 64px;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
  }
  li {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 150px minmax(0, 2fr) 130px auto;
    align-items: center;
    gap: 12px;
    min-height: 42px;
    padding: 0 12px 0 16px;
    border-top: 1px solid var(--border-weak);
  }
  li:first-child {
    border-top: 0;
  }
  li:hover {
    background: var(--bg-weak);
  }
  .host {
    overflow: hidden;
    color: var(--text-strong);
    text-overflow: ellipsis;
  }
  .type {
    color: var(--text-weak);
    font-size: 12px;
  }
  .fp {
    overflow: hidden;
    color: var(--text-weak);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 28px;
    border: 1px dashed var(--border-weak);
    border-radius: var(--radius-lg);
  }
</style>
