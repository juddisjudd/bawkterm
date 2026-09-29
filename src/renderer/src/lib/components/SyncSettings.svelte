<script lang="ts">
  import { app } from '$lib/state.svelte'
  import { ago } from '$lib/format'
  import CloudCheck from '@lucide/svelte/icons/cloud-check'
  import CloudAlert from '@lucide/svelte/icons/cloud-alert'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'

  const config = $derived(app.vault?.sync.config ?? null)
  const status = $derived(app.syncStatus)
  let busy = $state(false)

  async function run(task: () => Promise<unknown>, done?: string): Promise<void> {
    busy = true
    try {
      await task()
      if (done) app.toast(done)
    } catch (err) {
      app.fail(err)
    } finally {
      busy = false
    }
  }

  async function create(): Promise<void> {
    const res = await app.ask({
      title: 'Set up sync',
      message:
        'Use this on your first device. Run a bawksync server, then enter its address and one of its tokens. A new encryption key is created here and never leaves your devices unencrypted.',
      fields: [
        { name: 'url', label: 'server address', value: 'https://sync.bawkbawk.net' },
        { name: 'token', label: 'server token', secret: true }
      ],
      confirmLabel: 'Start syncing'
    })
    if (res) await run(() => window.api.sync.create(res.values.url, res.values.token), 'Sync is on')
  }

  async function join(): Promise<void> {
    const res = await app.ask({
      title: 'Join sync',
      message: 'Paste the sync link from a device that already syncs (settings → sync → copy sync link). Items on this device are merged in.',
      fields: [{ name: 'link', label: 'sync link', secret: true }],
      confirmLabel: 'Join'
    })
    if (res) await run(() => window.api.sync.join(res.values.link), 'Joined sync')
  }

  async function copyLink(): Promise<void> {
    const ok = await app.confirm(
      'Copy sync link',
      'The link contains the server token and the encryption key. Anyone who has it can read your whole vault. Paste it only into your own devices, then clear your clipboard.',
      'Copy link',
      false
    )
    if (!ok) return
    await run(async () => navigator.clipboard.writeText(await window.api.sync.link()), 'Sync link copied')
  }

  async function disconnect(): Promise<void> {
    const ok = await app.confirm(
      'Stop syncing',
      'This device stops syncing. Its data stays here, and other devices keep their copies. You can join again later with a sync link.',
      'Stop syncing'
    )
    if (ok) await run(() => window.api.sync.disconnect(), 'Sync is off on this device')
  }
</script>

<section>
  <h2>sync</h2>
  {#if !config}
    <p class="lead">
      Keep hosts, keys, identities, snippets and trusted host keys the same on every device. Everything is encrypted on
      this device first; the server only stores ciphertext. Settings like theme and fonts stay per device.
    </p>
    <div class="actions">
      <button type="button" class="btn strong" disabled={busy} onclick={create}>Set up new sync</button>
      <button type="button" class="btn" disabled={busy} onclick={join}>Join with sync link</button>
    </div>
  {:else}
    <div class="state">
      {#if status.phase === 'syncing'}
        <RefreshCw size={15} class="spin" /><span>syncing…</span>
      {:else if status.phase === 'error'}
        <CloudAlert size={15} class="failed" /><span>failed to sync</span>
      {:else}
        <CloudCheck size={15} /><span>synced</span><span class="muted">· last synced {ago(status.lastSyncAt)}</span>
      {/if}
    </div>
    {#if status.phase === 'error' && status.error}<p class="error selectable">{status.error}</p>{/if}
    <p class="muted server selectable">{config.url}</p>
    <p class="muted hint">Syncs after you change something and when you come back to the window.</p>
    <div class="actions">
      <button type="button" class="btn" disabled={busy || status.phase === 'syncing'} onclick={() => run(() => window.api.sync.now())}>
        Sync now
      </button>
      <button type="button" class="btn" disabled={busy} onclick={copyLink}>Copy sync link</button>
      <button type="button" class="btn ghost danger" disabled={busy} onclick={disconnect}>Stop syncing</button>
    </div>
  {/if}
</section>

<style>
  section {
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border-weak);
  }
  h2 {
    margin-bottom: 12px;
  }
  .lead {
    margin-bottom: 14px;
    line-height: 1.8;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-strong);
  }
  .state :global(.failed),
  .error {
    color: var(--danger);
  }
  .error {
    margin: 6px 0 0 25px;
    font-size: 12px;
  }
  .server {
    margin: 4px 0 0 25px;
    font-size: 12px;
  }
  .hint {
    margin: 2px 0 14px 25px;
    font-size: 12px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
