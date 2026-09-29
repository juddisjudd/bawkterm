<script lang="ts">
  import { blankSnippet } from '@shared/defaults'
  import type { Snippet } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import { focusOnMount } from '$lib/focus'
  import { MOD, mod } from '$lib/keys'
  import Drawer from './Drawer.svelte'

  let { snippetId, onclose }: { snippetId: string; onclose: () => void } = $props()

  // svelte-ignore state_referenced_locally
  const existing = app.vault?.snippets.find((s) => s.id === snippetId)
  let snippet = $state<Snippet>(existing ? structuredClone(existing) : blankSnippet())
  let busy = $state(false)

  async function save(): Promise<void> {
    const command = snippet.command.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (!command.trim()) {
      app.toast('Command is required', 'error')
      return
    }
    busy = true
    try {
      await window.api.snippets.save({
        ...$state.snapshot(snippet),
        label: snippet.label.trim() || command.split('\n')[0].slice(0, 40),
        command
      })
      onclose()
    } catch (err) {
      app.fail(err)
    } finally {
      busy = false
    }
  }
</script>

<Drawer title={existing ? 'edit snippet' : 'new snippet'} {onclose}>
  <label class="field">
    <span class="label">label</span>
    <input class="input" bind:value={snippet.label} placeholder="restart nginx" spellcheck="false" {@attach focusOnMount()} />
  </label>
  <label class="field">
    <span class="label">command</span>
    <textarea
      class="textarea command"
      bind:value={snippet.command}
      placeholder="sudo systemctl restart nginx"
      spellcheck="false"
      onkeydown={(e) => e.key === 'Enter' && mod(e) && save()}
    ></textarea>
    <span class="hint">Multiple lines run in order. {MOD}+Enter saves.</span>
  </label>

  {#snippet footer()}
    <button type="button" class="btn strong" disabled={busy} onclick={save}>Save</button>
    <button type="button" class="btn ghost" onclick={onclose}>Cancel</button>
  {/snippet}
</Drawer>

<style>
  .command {
    min-height: 180px;
    font-size: 12px;
  }
</style>
