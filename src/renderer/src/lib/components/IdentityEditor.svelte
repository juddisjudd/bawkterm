<script lang="ts">
  import { SECRET_KEPT, blankIdentity } from '@shared/defaults'
  import type { Identity } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import Drawer from './Drawer.svelte'
  import { focusOnMount } from '$lib/focus'

  let { identityId, onclose }: { identityId: string; onclose: () => void } = $props()

  const vault = $derived(app.vault!)
  // svelte-ignore state_referenced_locally
  const existing = app.vault?.identities.find((i) => i.id === identityId)
  let identity = $state<Identity>(existing ? structuredClone(existing) : blankIdentity())
  let busy = $state(false)
  let savedPassword = $state(identity.password === SECRET_KEPT)
  if (identity.password === SECRET_KEPT) identity.password = ''

  async function save(): Promise<void> {
    if (!identity.username.trim()) {
      app.toast('Username is required', 'error')
      return
    }
    busy = true
    try {
      await window.api.identities.save({
        ...$state.snapshot(identity),
        password: identity.password || (savedPassword ? SECRET_KEPT : ''),
        label: identity.label.trim() || identity.username.trim(),
        username: identity.username.trim()
      })
      onclose()
    } catch (err) {
      app.fail(err)
    } finally {
      busy = false
    }
  }
</script>

<Drawer title={existing ? 'edit identity' : 'new identity'} {onclose}>
  <label class="field">
    <span class="label">label</span>
    <input class="input" bind:value={identity.label} placeholder="deploy user" spellcheck="false" {@attach focusOnMount()} />
  </label>
  <label class="field">
    <span class="label">username</span>
    <input class="input" bind:value={identity.username} placeholder="root" spellcheck="false" />
  </label>
  <label class="field">
    <span class="label">password</span>
    <div class="with-button">
      <input
        class="input"
        type="password"
        bind:value={identity.password}
        placeholder={savedPassword ? 'saved (type to replace)' : 'optional'}
        autocomplete="off"
      />
      {#if savedPassword && !identity.password}
        <button type="button" class="btn ghost" onclick={() => (savedPassword = false)}>Remove</button>
      {/if}
    </div>
  </label>
  <label class="field">
    <span class="label">key</span>
    <select class="select" bind:value={identity.keyId}>
      <option value="">none</option>
      {#each vault.keys as k (k.id)}<option value={k.id}>{k.label} ({k.type})</option>{/each}
    </select>
  </label>

  {#snippet footer()}
    <button type="button" class="btn strong" disabled={busy} onclick={save}>Save</button>
    <button type="button" class="btn ghost" onclick={onclose}>Cancel</button>
  {/snippet}
</Drawer>

<style>
  .with-button {
    display: flex;
    gap: 6px;
  }
  .with-button .btn {
    height: 32px;
  }
</style>
