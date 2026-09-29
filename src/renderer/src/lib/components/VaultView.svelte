<script lang="ts">
  import Server from '@lucide/svelte/icons/server'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import SquareTerminal from '@lucide/svelte/icons/square-terminal'
  import ShieldCheck from '@lucide/svelte/icons/shield-check'
  import Settings from '@lucide/svelte/icons/settings'
  import Lock from '@lucide/svelte/icons/lock'
  import CloudCheck from '@lucide/svelte/icons/cloud-check'
  import CloudAlert from '@lucide/svelte/icons/cloud-alert'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import CircleArrowDown from '@lucide/svelte/icons/circle-arrow-down'
  import { app, type Section } from '$lib/state.svelte'
  import { ago } from '$lib/format'
  import HostsView from './HostsView.svelte'
  import KeychainView from './KeychainView.svelte'
  import KnownHostsView from './KnownHostsView.svelte'
  import SnippetsView from './SnippetsView.svelte'
  import SettingsView from './SettingsView.svelte'
  import { MOD } from '$lib/keys'

  const vault = $derived(app.vault!)
  const nav = $derived([
    { id: 'hosts' as Section, label: 'hosts', icon: Server, count: vault.hosts.length },
    { id: 'keychain' as Section, label: 'keychain', icon: KeyRound, count: vault.keys.length + vault.identities.length },
    { id: 'snippets' as Section, label: 'snippets', icon: SquareTerminal, count: vault.snippets.length },
    { id: 'known' as Section, label: 'known hosts', icon: ShieldCheck, count: vault.knownHosts.length },
    { id: 'settings' as Section, label: 'settings', icon: Settings, count: null }
  ])

  // quick syncs finish before the spinner is worth showing
  let syncShown = $state(app.syncStatus.phase)
  $effect(() => {
    const phase = app.syncStatus.phase
    if (phase !== 'syncing') {
      syncShown = phase
      return
    }
    const timer = setTimeout(() => (syncShown = 'syncing'), 600)
    return () => clearTimeout(timer)
  })
</script>

<div class="vault">
  <aside>
    <nav>
      {#each nav as item (item.id)}
        <button
          type="button"
          class={['item', app.section === item.id && 'active']}
          onclick={() => (app.section = item.id)}
        >
          <item.icon size={15} />
          <span class="label">{item.label}</span>
          {#if item.count !== null}<span class="count">{item.count}</span>{/if}
        </button>
      {/each}
    </nav>
    <div class="foot">
      {#if app.updateStatus.state === 'ready'}
        <button type="button" class="item update" title="Restart bawkterm to install the update" onclick={() => app.restartToUpdate()}>
          <CircleArrowDown size={15} />
          <span class="label">update to v{app.updateStatus.version}</span>
        </button>
      {/if}
      {#if app.syncStatus.phase !== 'off'}
        <button
          type="button"
          class="item sync"
          title={syncShown === 'error' ? app.syncStatus.error : `Last synced ${ago(app.syncStatus.lastSyncAt)}`}
          onclick={() => {
            app.settingsTab = 'sync'
            app.section = 'settings'
          }}
        >
          {#if syncShown === 'syncing'}
            <RefreshCw size={15} class="spin" />
            <span class="label">syncing…</span>
          {:else if syncShown === 'error'}
            <CloudAlert size={15} class="failed" />
            <span class="label">failed to sync</span>
          {:else}
            <CloudCheck size={15} class="synced" />
            <span class="label">synced</span>
          {/if}
        </button>
      {/if}
      <button type="button" class="item" onclick={() => app.lock()} title="Lock vault ({MOD}+Shift+L)">
        <Lock size={15} />
        <span class="label">lock</span>
      </button>
    </div>
  </aside>
  <section class="content">
    {#if app.section === 'hosts'}
      <HostsView />
    {:else if app.section === 'keychain'}
      <KeychainView />
    {:else if app.section === 'snippets'}
      <SnippetsView />
    {:else if app.section === 'known'}
      <KnownHostsView />
    {:else}
      <SettingsView />
    {/if}
  </section>
</div>

<style>
  .vault {
    display: flex;
    height: 100%;
  }
  aside {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    width: 200px;
    flex: none;
    padding: 12px 8px;
    border-right: 1px solid var(--border-weak);
  }
  nav,
  .foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-weak);
    text-align: left;
    cursor: pointer;
  }
  .item:hover {
    color: var(--text-strong);
    background: var(--bg-weak);
  }
  .item.active {
    background: var(--bg-weak-hover);
    color: var(--text-strong);
  }
  .label {
    flex: 1;
  }
  .update {
    color: var(--text-strong);
  }
  .update :global(svg) {
    color: var(--success);
  }
  .sync :global(.synced) {
    color: var(--success);
  }
  .sync :global(.failed) {
    color: var(--danger);
  }
  .count {
    color: var(--text-weak);
    font-size: 12px;
  }
  .content {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
</style>
