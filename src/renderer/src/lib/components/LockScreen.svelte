<script lang="ts">
  import { app } from '$lib/state.svelte'
  import Logo from './Logo.svelte'
  import Checkbox from './Checkbox.svelte'
  import { focusOnMount } from '$lib/focus'

  const creating = $derived(app.status?.state === 'none')
  let password = $state('')
  let confirm = $state('')
  let remember = $state(app.status?.remembered ?? false)
  let busy = $state(false)
  let error = $state('')

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
  .submit {
    align-self: flex-start;
    height: 34px;
    padding: 0 16px;
  }
</style>
