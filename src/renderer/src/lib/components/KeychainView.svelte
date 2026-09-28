<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus'
  import Copy from '@lucide/svelte/icons/copy'
  import type { Identity, SshKey } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import PageHeader from './PageHeader.svelte'
  import KeyImport from './KeyImport.svelte'
  import KeyGenerate from './KeyGenerate.svelte'
  import IdentityEditor from './IdentityEditor.svelte'

  const vault = $derived(app.vault!)
  let drawer = $state<'import' | 'generate' | null>(null)
  let editingIdentity = $state<string | null>(null)

  function usage(k: SshKey): number {
    return (
      vault.hosts.filter((h) => h.keyId === k.id).length + vault.identities.filter((i) => i.keyId === k.id).length
    )
  }

  async function copyPublic(k: SshKey): Promise<void> {
    if (!k.publicKey) {
      app.toast('Public key unknown until the key is unlocked once', 'error')
      return
    }
    await navigator.clipboard.writeText(k.publicKey)
    app.toast('Public key copied. Paste it into ~/.ssh/authorized_keys on the server.')
  }

  async function renameKey(k: SshKey): Promise<void> {
    const label = await app.askText('Rename key', 'label', k.label)
    if (label) await window.api.keys.rename(k.id, label).catch((err) => app.fail(err))
  }

  async function removeKey(k: SshKey): Promise<void> {
    const n = usage(k)
    const ok = await app.confirm(
      'Delete key',
      `Delete "${k.label}"?${n ? ` ${n} host(s) or identities use it and will lose this key.` : ''} This cannot be undone.`
    )
    if (ok) await window.api.keys.remove(k.id).catch((err) => app.fail(err))
  }

  async function removeIdentity(i: Identity): Promise<void> {
    if (await app.confirm('Delete identity', `Delete identity "${i.label}"?`)) {
      await window.api.identities.remove(i.id).catch((err) => app.fail(err))
    }
  }

  function keyMenu(e: MouseEvent, k: SshKey): void {
    app.openMenu(e, [
      { label: 'Copy public key', action: () => copyPublic(k), disabled: !k.publicKey },
      { label: 'Rename', action: () => renameKey(k) },
      'sep',
      { label: 'Delete', danger: true, action: () => removeKey(k) }
    ])
  }
</script>

<div class="page">
  <PageHeader title="keychain" subtitle="SSH keys and reusable login identities">
    {#snippet actions()}
      <button type="button" class="btn" onclick={() => (drawer = 'import')}>Import key</button>
      <button type="button" class="btn" onclick={() => (editingIdentity = '')}>New identity</button>
      <button type="button" class="btn strong" onclick={() => (drawer = 'generate')}><Plus /> Generate key</button>
    {/snippet}
  </PageHeader>

  <h2>keys <span class="muted">({vault.keys.length})</span></h2>
  {#if vault.keys.length}
    <ul>
      {#each vault.keys as k (k.id)}
        <li class="key" oncontextmenu={(e) => keyMenu(e, k)}>
          <span class="label">{k.label}</span>
          <span class="type">{k.type}{k.encrypted ? ' · locked' : ''}</span>
          <span class="fp selectable" title={k.fingerprint}>{k.fingerprint || 'fingerprint unknown'}</span>
          <span class="used">{usage(k)} in use</span>
          <span class="actions">
            <button type="button" class="btn small" onclick={() => copyPublic(k)} disabled={!k.publicKey}>
              <Copy /> public
            </button>
            <button type="button" class="btn small ghost" onclick={() => renameKey(k)}>rename</button>
            <button type="button" class="btn small ghost danger" onclick={() => removeKey(k)}>delete</button>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="empty">
      <p class="strong">[ ] no keys yet</p>
      <p class="muted">Generate an ed25519 key or import an existing private key file.</p>
    </div>
  {/if}

  <h2>identities <span class="muted">({vault.identities.length})</span></h2>
  <p class="muted intro">An identity is a username with a password or key. Attach it to many hosts and edit it once.</p>
  {#if vault.identities.length}
    <ul>
      {#each vault.identities as i (i.id)}
        {@const key = vault.keys.find((k) => k.id === i.keyId)}
        <li class="identity">
          <span class="label">{i.label}</span>
          <span>{i.username}</span>
          <span class="type">{[i.password && 'password', key && `key: ${key.label}`].filter(Boolean).join(' · ') || 'no secret'}</span>
          <span class="used">{vault.hosts.filter((h) => h.identityId === i.id).length} hosts</span>
          <span class="actions">
            <button type="button" class="btn small ghost" onclick={() => (editingIdentity = i.id)}>edit</button>
            <button type="button" class="btn small ghost danger" onclick={() => removeIdentity(i)}>delete</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}

</div>

{#if drawer === 'import'}
  <KeyImport onclose={() => (drawer = null)} />
{:else if drawer === 'generate'}
  <KeyGenerate onclose={() => (drawer = null)} />
{/if}
{#if editingIdentity !== null}
  <IdentityEditor identityId={editingIdentity} onclose={() => (editingIdentity = null)} />
{/if}

<style>
  .page {
    max-width: 1080px;
    padding: 32px 40px 64px;
  }
  h2 {
    margin: 8px 0 10px;
  }
  .intro {
    margin: -4px 0 12px;
  }
  ul {
    margin: 0 0 28px;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
  }
  li {
    display: grid;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 0 12px 0 16px;
    border-top: 1px solid var(--border-weak);
  }
  li:first-child {
    border-top: 0;
  }
  li:hover {
    background: var(--bg-weak);
  }
  .key {
    grid-template-columns: minmax(120px, 1fr) 150px minmax(0, 1.6fr) 72px auto;
  }
  .identity {
    grid-template-columns: minmax(120px, 1fr) minmax(80px, 0.8fr) minmax(0, 1.4fr) 72px auto;
  }
  .label {
    overflow: hidden;
    color: var(--text-strong);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .type,
  .used {
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
  .actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 28px;
    padding: 28px;
    border: 1px dashed var(--border-weak);
    border-radius: var(--radius-lg);
  }
</style>
