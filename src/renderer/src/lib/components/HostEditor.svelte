<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import { blankHost } from '@shared/defaults'
  import type { Host } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import Drawer from './Drawer.svelte'
  import Checkbox from './Checkbox.svelte'
  import { focusOnMount } from '$lib/focus'

  let { hostId, onclose }: { hostId: string; onclose: () => void } = $props()

  const vault = $derived(app.vault!)
  // svelte-ignore state_referenced_locally
  const existing = app.vault?.hosts.find((h) => h.id === hostId)
  let host = $state<Host>(existing ? structuredClone(existing) : blankHost())
  let tags = $state(host.tags.join(', '))
  let showPassword = $state(false)
  let saving = $state(false)

  const identity = $derived(vault.identities.find((i) => i.id === host.identityId))
  const groups = $derived([...new Set(vault.hosts.map((h) => h.group).filter(Boolean))].sort())
  const jumpOptions = $derived(vault.hosts.filter((h) => h.id !== host.id))

  async function save(connect: boolean): Promise<void> {
    if (!host.address.trim()) {
      app.toast('Address is required', 'error')
      return
    }
    saving = true
    try {
      const saved = await window.api.hosts.save({
        ...$state.snapshot(host),
        label: host.label.trim() || host.address.trim(),
        address: host.address.trim(),
        port: Number(host.port) || 22,
        group: host.group.trim(),
        username: host.username.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      })
      onclose()
      if (connect) app.openHost('ssh', saved.id)
    } catch (err) {
      app.fail(err)
    } finally {
      saving = false
    }
  }

  async function remove(): Promise<void> {
    if (!(await app.confirm('Delete host', `Delete "${host.label || host.address}" from the vault?`))) return
    await window.api.hosts.remove(host.id).catch((err) => app.fail(err))
    onclose()
  }
</script>

<Drawer title={existing ? 'edit host' : 'new host'} {onclose}>
  <label class="field">
    <span class="label">address</span>
    <div class="row-fields">
      <input
        class="input"
        bind:value={host.address}
        placeholder="203.0.113.10 or server.example.com"
        spellcheck="false"
        {@attach focusOnMount(!existing)}
      />
      <input class="input" type="number" min="1" max="65535" bind:value={host.port} aria-label="port" />
    </div>
  </label>
  <label class="field">
    <span class="label">label</span>
    <input class="input" bind:value={host.label} placeholder={host.address || 'my server'} spellcheck="false" />
  </label>
  <div class="split">
    <label class="field">
      <span class="label">group</span>
      <input class="input" bind:value={host.group} list="host-groups" placeholder="none" spellcheck="false" />
      <datalist id="host-groups">
        {#each groups as g (g)}<option value={g}></option>{/each}
      </datalist>
    </label>
    <label class="field">
      <span class="label">tags</span>
      <input class="input" bind:value={tags} placeholder="prod, web" spellcheck="false" />
    </label>
  </div>

  <h3>credentials</h3>
  <label class="field">
    <span class="label">identity</span>
    <select class="select" bind:value={host.identityId}>
      <option value="">none — use fields below</option>
      {#each vault.identities as i (i.id)}<option value={i.id}>{i.label} ({i.username})</option>{/each}
    </select>
  </label>
  <label class="field">
    <span class="label">username</span>
    <input
      class="input"
      bind:value={host.username}
      placeholder={identity?.username ? `${identity.username} (from identity)` : 'root'}
      spellcheck="false"
    />
  </label>
  <label class="field">
    <span class="label">password</span>
    <div class="with-button">
      <input
        class="input"
        type={showPassword ? 'text' : 'password'}
        bind:value={host.password}
        placeholder={identity?.password ? '•••••• (from identity)' : 'ask when connecting'}
        autocomplete="off"
      />
      <button
        type="button"
        class="btn icon"
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        onclick={() => (showPassword = !showPassword)}
      >
        {#if showPassword}<EyeOff />{:else}<Eye />{/if}
      </button>
    </div>
  </label>
  <label class="field">
    <span class="label">key</span>
    <select class="select" bind:value={host.keyId}>
      <option value="">{identity?.keyId ? 'from identity' : 'none'}</option>
      {#each vault.keys as k (k.id)}<option value={k.id}>{k.label} ({k.type})</option>{/each}
    </select>
  </label>
  <Checkbox bind:checked={host.useAgent} label="try keys from the SSH agent (OpenSSH agent or Pageant)" />

  <h3>connection</h3>
  <label class="field">
    <span class="label">jump host</span>
    <select class="select" bind:value={host.jumpHostId}>
      <option value="">none — connect directly</option>
      {#each jumpOptions as h (h.id)}<option value={h.id}>{h.label || h.address}</option>{/each}
    </select>
  </label>
  <label class="field">
    <span class="label">notes</span>
    <textarea class="textarea" bind:value={host.notes} spellcheck="false"></textarea>
  </label>

  {#snippet footer()}
    <button type="button" class="btn strong" disabled={saving} onclick={() => save(false)}>Save</button>
    <button type="button" class="btn" disabled={saving} onclick={() => save(true)}>Save and connect</button>
    <span class="spacer"></span>
    {#if existing}
      <button type="button" class="btn danger" onclick={remove}>Delete</button>
    {/if}
  {/snippet}
</Drawer>

<style>
  h3 {
    margin: 8px 0 -4px;
    color: var(--text-strong);
    font-size: 12px;
    font-weight: 500;
  }
  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .with-button {
    display: flex;
    gap: 6px;
  }
  .with-button .btn {
    height: 32px;
    width: 32px;
  }
  .spacer {
    flex: 1;
  }
</style>
