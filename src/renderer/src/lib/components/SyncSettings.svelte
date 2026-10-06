<script lang="ts">
  import { app } from '$lib/state.svelte'
  import { ago } from '$lib/format'
  import CloudCheck from '@lucide/svelte/icons/cloud-check'
  import CloudAlert from '@lucide/svelte/icons/cloud-alert'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'

  const config = $derived(app.vault?.sync.config ?? null)
  const folder = $derived(config && 'kind' in config ? config.folder : null)
  const server = $derived(config && !('kind' in config) ? config.url : null)
  const status = $derived(app.syncStatus)
  let busy = $state(false)

  async function run(task: () => Promise<unknown>, done?: string): Promise<boolean> {
    busy = true
    try {
      await task()
      if (done) app.toast(done)
      return true
    } catch (err) {
      app.fail(err)
      return false
    } finally {
      busy = false
    }
  }

  async function chooseFolder(): Promise<{ folder: string; held: boolean } | null> {
    let choice: { folder: string; held: boolean } | null = null
    await run(async () => (choice = await window.api.sync.chooseFolder()))
    return choice
  }

  async function createFolder(): Promise<void> {
    const choice = await chooseFolder()
    if (!choice) return
    const erase =
      choice.held &&
      (await app.confirm(
        'This folder already has a synced vault',
        'If another device still syncs with it, cancel and use Join with sync link instead. Otherwise, erase the synced copy in this folder and upload this vault. The erased copy cannot be recovered.',
        'Erase and start fresh'
      ))
    if (choice.held && !erase) return
    if (await run(() => window.api.sync.createFolder(erase), 'Sync is on')) await offerLink()
  }

  async function createServer(): Promise<void> {
    const res = await app.ask({
      title: 'Set up server sync',
      message:
        'Use this on your first device. Run a bawksync server, then enter its address and one of its tokens. A new encryption key is created here and never leaves your devices unencrypted.',
      fields: [
        { name: 'url', label: 'server address', value: 'https://sync.bawkbawk.net' },
        { name: 'token', label: 'server token', secret: true }
      ],
      confirmLabel: 'Start syncing'
    })
    if (!res) return
    const { url, token } = res.values
    let held = 0
    if (!(await run(async () => (held = await window.api.sync.check(url, token))))) return
    const erase =
      held > 0 &&
      (await app.confirm(
        'This server already has a synced vault',
        'If another device still syncs with it, cancel and use Join with sync link instead. Otherwise, erase the server copy and upload this vault. The erased copy cannot be recovered.',
        'Erase and start fresh'
      ))
    if (held > 0 && !erase) return
    if (await run(() => window.api.sync.create(url, token, erase), 'Sync is on')) await offerLink()
  }

  async function offerLink(): Promise<void> {
    const res = await app.ask({
      title: 'Save your sync link',
      message:
        'Other devices need it to join, and it is the only way to get your synced data back if you lose every device. Keep it in a password manager. Anyone who has it can read your vault.',
      fields: [{ name: 'password', label: 'master password', secret: true }],
      confirmLabel: 'Copy sync link',
      cancelLabel: 'Later'
    })
    const password = res?.values.password
    if (password) {
      await run(() => window.api.sync.copyLink(password), 'Sync link copied. It is cleared from the clipboard in a minute.')
    }
  }

  // only to word the warning before joining; the main process checks the link itself
  function readLink(link: string): { folder: boolean; server: string | null } {
    try {
      const body = JSON.parse(atob(link.trim().replace(/^bawksync:/, '').replace(/-/g, '+').replace(/_/g, '/')))
      return { folder: body.f === 1, server: typeof body.u === 'string' ? new URL(body.u).host : null }
    } catch {
      return { folder: false, server: null }
    }
  }

  async function join(): Promise<void> {
    const res = await app.ask({
      title: 'Join sync',
      message: 'Paste the sync link from a device that already syncs (settings → sync → copy sync link). Items on this device are merged in.',
      fields: [{ name: 'link', label: 'sync link', secret: true }],
      confirmLabel: 'Next'
    })
    if (!res) return
    const link = res.values.link
    const kind = readLink(link)
    const choice = kind.folder ? await chooseFolder() : null
    if (kind.folder && !choice) return
    // whoever made the link can read everything this device writes, so say that before anything leaves
    const ok = await app.confirm(
      'Join this sync?',
      choice
        ? `Everything in this vault, including passwords and private keys, will be written to ${choice.folder}, encrypted with the key in the link. Anyone who has this link and the folder can read it. Only use a link you copied from your own device.`
        : `Everything in this vault, including passwords and private keys, will be uploaded to ${kind.server ?? 'the server in the link'}, encrypted with the key in the link. Anyone who has this link can read it. Only use a link you copied from your own device.`,
      'Join and upload'
    )
    if (!ok) return
    await run(() => (choice ? window.api.sync.joinFolder(link) : window.api.sync.join(link)), 'Joined sync')
  }

  async function copyLink(): Promise<void> {
    const password = await app.askMasterPassword(
      folder
        ? 'The link contains the encryption key. Anyone who has it and a copy of the folder can read your whole vault. Paste it only into your own devices.'
        : 'The link contains the server token and the encryption key. Anyone who has it can read your whole vault. Paste it only into your own devices.',
      'Copy link'
    )
    if (!password) return
    await run(() => window.api.sync.copyLink(password), 'Sync link copied. It is cleared from the clipboard in a minute.')
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

{#if !config}
  <p class="lead">
    Keeps hosts, keys, identities, snippets and trusted host keys the same on all your devices. Items are encrypted on
    this device first, so the folder or server holds only ciphertext. Settings are not synced.
  </p>
  <div class="ways">
    <div class="way">
      <span class="stack">
        <span>shared folder</span>
        <span class="muted">Dropbox, OneDrive, iCloud Drive, Syncthing or a network share. No server needed.</span>
      </span>
      <button type="button" class="btn strong" disabled={busy} onclick={createFolder}>Set up folder sync</button>
    </div>
    <div class="way">
      <span class="stack">
        <span>bawksync server</span>
        <span class="muted">A small server you run yourself, in Docker or on Cloudflare Workers.</span>
      </span>
      <button type="button" class="btn" disabled={busy} onclick={createServer}>Set up server sync</button>
    </div>
  </div>
  <div class="join">
    <span class="muted">Already syncing on another device?</span>
    <button type="button" class="btn" disabled={busy} onclick={join}>Join with sync link</button>
  </div>
{:else}
  <div class="state">
    {#if status.phase === 'syncing'}
      <RefreshCw size={15} class="spin" /><span>syncing…</span>
    {:else if status.phase === 'error'}
      <CloudAlert size={15} class="failed" /><span>failed to sync</span>
    {:else}
      <CloudCheck size={15} class="synced" /><span>synced</span><span class="muted">· last synced {ago(status.lastSyncAt)}</span>
    {/if}
  </div>
  {#if status.phase === 'error' && status.error}<p class="error selectable">{status.error}</p>{/if}
  <p class="muted server selectable">{folder ? `folder · ${folder}` : server}</p>
  <div class="actions">
    <button type="button" class="btn" disabled={busy || status.phase === 'syncing'} onclick={() => run(() => window.api.sync.now())}>
      Sync now
    </button>
    <button type="button" class="btn" disabled={busy} onclick={copyLink}>Copy sync link</button>
    <button type="button" class="btn ghost danger" disabled={busy} onclick={disconnect}>Stop syncing</button>
  </div>
  <p class="hint">
    {folder
      ? 'Other devices join with the sync link and pick their own copy of this folder. '
      : ''}Keep a copy of your sync link in a password manager. If you lose every device, it is the only way to get your synced data back.
  </p>
{/if}

<style>
  .lead {
    margin-bottom: 14px;
    line-height: 1.8;
  }
  .ways {
    display: grid;
    border-top: 1px solid var(--border-weak);
  }
  .way {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border-weak);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--text-strong);
  }
  .stack .muted {
    font-size: 12px;
  }
  .join {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 14px;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-strong);
  }
  .state :global(.synced) {
    color: var(--success);
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
    margin: 4px 0 14px 25px;
    font-size: 12px;
  }
  .hint {
    margin-top: 14px;
    color: var(--text-weak);
    font-size: 12px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
