<script lang="ts">
  import type { KeyGenType, SshKey } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import Drawer from './Drawer.svelte'

  let { onclose }: { onclose: () => void } = $props()

  const types: { id: KeyGenType; label: string; note: string }[] = [
    { id: 'ed25519', label: 'ed25519', note: 'recommended — small, fast, modern' },
    { id: 'rsa-4096', label: 'rsa 4096', note: 'for old servers that lack ed25519' },
    { id: 'ecdsa-256', label: 'ecdsa p-256', note: 'for FIPS or hardware requirements' },
    { id: 'ecdsa-521', label: 'ecdsa p-521', note: 'larger ecdsa curve' }
  ]

  let type = $state<KeyGenType>('ed25519')
  let label = $state('')
  let comment = $state('bawkterm')
  let passphrase = $state('')
  let busy = $state(false)
  let created = $state<SshKey | null>(null)

  async function generate(): Promise<void> {
    busy = true
    try {
      created = await window.api.keys.generate({ type, label: label.trim(), comment: comment.trim(), passphrase })
    } catch (err) {
      app.fail(err)
    } finally {
      busy = false
    }
  }

  async function copy(): Promise<void> {
    if (!created) return
    await navigator.clipboard.writeText(created.publicKey)
    app.toast('Public key copied')
  }
</script>

<Drawer title="generate key" {onclose}>
  {#if created}
    <p class="strong">[x] created "{created.label}"</p>
    <p class="muted">Add this public key to ~/.ssh/authorized_keys on each server:</p>
    <pre class="mono-block">{created.publicKey}</pre>
    <p class="muted">fingerprint {created.fingerprint}</p>
  {:else}
    <div class="field">
      <span class="label">type</span>
      <div class="types" role="radiogroup">
        {#each types as t (t.id)}
          <button type="button" role="radio" aria-checked={type === t.id} class:active={type === t.id} onclick={() => (type = t.id)}>
            <span class="box">({type === t.id ? '*' : ' '})</span>
            <span class="strong">{t.label}</span>
            <span class="muted">{t.note}</span>
          </button>
        {/each}
      </div>
    </div>
    <label class="field">
      <span class="label">label</span>
      <input class="input" bind:value={label} placeholder="laptop key" spellcheck="false" />
    </label>
    <label class="field">
      <span class="label">comment</span>
      <input class="input" bind:value={comment} spellcheck="false" />
      <span class="hint">Appears at the end of the public key.</span>
    </label>
    <label class="field">
      <span class="label">passphrase (optional)</span>
      <input class="input" type="password" bind:value={passphrase} autocomplete="off" />
      <span class="hint">Your vault already encrypts the key. Add one if you plan to export it.</span>
    </label>
  {/if}

  {#snippet footer()}
    {#if created}
      <button type="button" class="btn strong" onclick={copy}>Copy public key</button>
      <button type="button" class="btn ghost" onclick={onclose}>Done</button>
    {:else}
      <button type="button" class="btn strong" disabled={busy} onclick={generate}>
        {busy ? 'generating…' : 'Generate'}
      </button>
      <button type="button" class="btn ghost" onclick={onclose}>Cancel</button>
    {/if}
  {/snippet}
</Drawer>

<style>
  .types {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
  }
  .types button {
    display: grid;
    grid-template-columns: 32px 110px 1fr;
    align-items: center;
    padding: 8px 10px;
    border: 0;
    border-top: 1px solid var(--border-weak);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .types button:first-child {
    border-top: 0;
  }
  .types button:hover,
  .types button.active {
    background: var(--bg-weak);
  }
  .box {
    color: var(--text-strong);
    white-space: pre;
  }
  pre {
    margin: 0;
    font: inherit;
    font-size: 12px;
  }
</style>
