<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import { SECRET_KEPT, blankHost } from '@shared/defaults'
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
  // the window only learns that a password is saved; typing replaces it, the eye asks main for the real one
  let savedPassword = $state(host.password === SECRET_KEPT)
  if (host.password === SECRET_KEPT) host.password = ''

  async function togglePassword(): Promise<void> {
    if (showPassword || !savedPassword || host.password) {
      showPassword = !showPassword
      return
    }
    const password = await app.askMasterPassword('Showing a saved password needs your master password.', 'Show')
    if (!password) return
    try {
      host.password = await window.api.secrets.reveal('host', host.id, password)
      savedPassword = false
      showPassword = true
    } catch (err) {
      app.fail(err)
    }
  }

  const identity = $derived(vault.identities.find((i) => i.id === host.identityId))
  const groups = $derived([...new Set(vault.hosts.map((h) => h.group).filter(Boolean))].sort())
  const jumpOptions = $derived(vault.hosts.filter((h) => h.id !== host.id && h.kind === 'ssh'))
  const rdp = $derived(host.kind === 'rdp')

  function setKind(kind: Host['kind']): void {
    if (kind === host.kind) return
    if (kind === 'rdp' && host.port === 22) host.port = 3389
    if (kind === 'ssh' && host.port === 3389) host.port = 22
    host.kind = kind
  }

  async function save(connect: boolean): Promise<void> {
    if (!host.address.trim()) {
      app.toast('Address is required', 'error')
      return
    }
    saving = true
    try {
      const saved = await window.api.hosts.save({
        ...$state.snapshot(host),
        password: host.password || (savedPassword ? SECRET_KEPT : ''),
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
  <div class="field">
    <span class="label">type</span>
    <div class="seg" role="radiogroup">
      <button type="button" role="radio" aria-checked={!rdp} class:active={!rdp} onclick={() => setKind('ssh')}>ssh</button>
      <button type="button" role="radio" aria-checked={rdp} class:active={rdp} onclick={() => setKind('rdp')}>rdp</button>
    </div>
  </div>
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
      placeholder={identity?.username ? `${identity.username} (from identity)` : rdp ? 'DOMAIN\\user or user' : 'root'}
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
        placeholder={savedPassword
          ? 'saved (type to replace)'
          : identity?.password
            ? '•••••• (from identity)'
            : rdp
              ? 'Remote Desktop asks when empty'
              : 'ask when connecting'}
        autocomplete="off"
      />
      <button type="button" class="btn icon" aria-label={showPassword ? 'Hide password' : 'Show password'} onclick={togglePassword}>
        {#if showPassword}<EyeOff />{:else}<Eye />{/if}
      </button>
      {#if savedPassword && !host.password}
        <button type="button" class="btn ghost" onclick={() => (savedPassword = false)}>Remove</button>
      {/if}
    </div>
  </label>
  {#if rdp}
    <Checkbox bind:checked={host.rdpFullscreen} label="open full screen" />
  {:else}
  <label class="field">
    <span class="label">key</span>
    <select class="select" bind:value={host.keyId}>
      <option value="">{identity?.keyId ? 'from identity' : 'none'}</option>
      {#each vault.keys as k (k.id)}<option value={k.id}>{k.label} ({k.type})</option>{/each}
    </select>
  </label>
  <Checkbox bind:checked={host.useAgent} label="try keys from SSH agents (OpenSSH agent and Pageant, security keys included)" />
  <Checkbox bind:checked={host.agentForward} label="forward my keys to this server (agent forwarding), for git or ssh from there" />
  {#if host.agentForward}
    <span class="hint">The server can then use this host's key and your agents' keys while you are connected. Its admins can too, so only turn this on for servers you trust.</span>
  {/if}
  <label class="field">
    <span class="label">run after connect</span>
    <input class="input" bind:value={host.startupCommand} placeholder="tmux attach || tmux new" spellcheck="false" />
    <span class="hint">Typed into the shell once it opens, also after an automatic reconnect.</span>
  </label>
  {/if}

  <h3>connection</h3>
  <label class="field">
    <span class="label">jump host</span>
    <select class="select" bind:value={host.jumpHostId}>
      <option value="">none — connect directly</option>
      {#each jumpOptions as h (h.id)}<option value={h.id}>{h.label || h.address}</option>{/each}
    </select>
    {#if rdp && host.jumpHostId}<span class="hint">Remote Desktop is tunnelled through this SSH host.</span>{/if}
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
  .seg {
    display: flex;
    align-self: flex-start;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .seg button {
    height: 28px;
    padding: 0 16px;
    border: 0;
    border-left: 1px solid var(--border-weak);
    background: none;
    color: var(--text-weak);
    cursor: pointer;
  }
  .seg button:first-child {
    border-left: 0;
  }
  .seg button.active {
    background: var(--bg-strong);
    color: var(--text-inverted);
  }
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
  }
  .with-button .btn.icon {
    width: 32px;
  }
  .spacer {
    flex: 1;
  }
</style>
