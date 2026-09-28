<script lang="ts">
  import { app } from '$lib/state.svelte'
  import Drawer from './Drawer.svelte'

  let { onclose }: { onclose: () => void } = $props()

  let label = $state('')
  let privateKey = $state('')
  let passphrase = $state('')
  let busy = $state(false)

  async function pickFile(): Promise<void> {
    try {
      const file = await window.api.keys.readFile()
      if (!file) return
      privateKey = file.content
      if (!label) label = file.name
    } catch (err) {
      app.fail(err)
    }
  }

  async function save(): Promise<void> {
    busy = true
    try {
      const key = await window.api.keys.import({ label: label.trim(), privateKey, passphrase })
      app.toast(`Imported ${key.type} key "${key.label}"`)
      onclose()
    } catch (err) {
      app.fail(err)
    } finally {
      busy = false
    }
  }
</script>

<Drawer title="import key" {onclose}>
  <p class="muted">Supports OpenSSH, PEM (RSA, ECDSA) and PuTTY .ppk private keys.</p>
  <button type="button" class="btn" onclick={pickFile}>Choose file…</button>
  <label class="field">
    <span class="label">private key</span>
    <textarea
      class="textarea key"
      bind:value={privateKey}
      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
      spellcheck="false"
    ></textarea>
  </label>
  <label class="field">
    <span class="label">label</span>
    <input class="input" bind:value={label} placeholder="uses the key comment when empty" spellcheck="false" />
  </label>
  <label class="field">
    <span class="label">passphrase</span>
    <input class="input" type="password" bind:value={passphrase} placeholder="only for encrypted keys" autocomplete="off" />
    <span class="hint">Stored encrypted in the vault so you are not asked on every connection.</span>
  </label>

  {#snippet footer()}
    <button type="button" class="btn strong" disabled={busy || !privateKey.trim()} onclick={save}>Import</button>
    <button type="button" class="btn ghost" onclick={onclose}>Cancel</button>
  {/snippet}
</Drawer>

<style>
  .key {
    min-height: 200px;
    font-size: 11px;
  }
</style>
