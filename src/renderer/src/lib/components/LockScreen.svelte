<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '$lib/state.svelte'
  import Logo from './Logo.svelte'
  import Checkbox from './Checkbox.svelte'
  import { focusOnMount } from '$lib/focus'
  import { passkeySecret } from '$lib/passkey'
  import type { VaultData } from '@shared/types'

  const creating = $derived(app.status?.state === 'none')
  let password = $state('')
  let confirm = $state('')
  let remember = $state(app.status?.remembered ?? false)
  let busy = $state(false)
  let error = $state('')

  const methods = $derived(app.unlockStatus)
  const passkey = $derived(methods?.passkey.enabled ? methods.passkey : null)

  onMount(() => void app.refreshUnlock())

  async function finish(open: () => Promise<VaultData>): Promise<void> {
    error = ''
    busy = true
    try {
      app.setVault(await open())
      await app.refreshStatus()
    } catch (err) {
      error = (err as Error).message
    } finally {
      busy = false
    }
  }

  function withHello(): Promise<void> {
    return finish(() => window.api.unlock.hello())
  }

  function withPasskey(): Promise<void> {
    return finish(async () => window.api.unlock.passkey(await passkeySecret(passkey!)))
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault()
    error = ''
    if (creating && password !== confirm) {
      error = 'The two passwords do not match.'
      return
    }
    busy = true
    try {
      const data = creating
        ? await window.api.vault.create(password, remember)
        : await window.api.vault.unlock(password, remember)
      password = ''
      confirm = ''
      app.setVault(data)
      await app.refreshStatus()
    } catch (err) {
      error = (err as Error).message
    } finally {
      busy = false
    }
  }
</script>

<div class="lock">
  <div class="drag"></div>
  <form class="card" onsubmit={submit}>
    <Logo size={30} />
    {#if creating}
      <p class="lead">Create a master password.</p>
      <p class="muted">
        It encrypts every host, key and password in your vault on this device. It cannot be recovered, so store it
        somewhere safe.
      </p>
    {:else}
      <p class="lead">Your vault is locked.</p>
    {/if}

    <label class="field">
      <span class="label">master password</span>
      <input class="input" type="password" bind:value={password} {@attach focusOnMount()} autocomplete="off" />
    </label>
    {#if creating}
      <label class="field">
        <span class="label">confirm password</span>
        <input class="input" type="password" bind:value={confirm} autocomplete="off" />
      </label>
    {/if}

    {#if app.status?.canRemember}
      <Checkbox bind:checked={remember} label="unlock automatically on this device" />
    {/if}

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <button class="btn strong submit" type="submit" disabled={busy || !password}>
      {busy ? 'working…' : creating ? 'Create vault' : 'Unlock'}
      <span aria-hidden="true">→</span>
    </button>

    {#if !creating && (methods?.hello.enabled || passkey)}
      <div class="alt">
        <span class="muted">or</span>
        {#if methods?.hello.enabled}
          <button type="button" class="btn" disabled={busy} onclick={withHello}>Windows Hello</button>
        {/if}
        {#if passkey}
          <button type="button" class="btn" disabled={busy} onclick={withPasskey}>Passkey</button>
        {/if}
      </div>
    {/if}
  </form>
</div>

<style>
  .lock {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: var(--bg);
  }
  .drag {
    position: absolute;
    inset: 0 0 auto 0;
    height: var(--titlebar);
    -webkit-app-region: drag;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(420px, calc(100vw - 48px));
    padding: 32px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
  }
  .lead {
    color: var(--text-strong);
    font-size: 15px;
  }
  .muted {
    line-height: 1.8;
  }
  .error {
    color: var(--danger);
  }
  .alt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 14px;
    border-top: 1px solid var(--border-weak);
  }
  .submit {
    align-self: flex-start;
    height: 34px;
    padding: 0 16px;
  }
</style>
