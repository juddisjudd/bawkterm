<script lang="ts">
  import { app, type Modal } from '$lib/state.svelte'
  import Checkbox from './Checkbox.svelte'
  import { focusOnMount } from '$lib/focus'

  let { modal }: { modal: Modal } = $props()

  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>(Object.fromEntries(modal.fields.map((f) => [f.name, f.value ?? ''])))
  let checked = $state(false)
  // risky prompts start on Cancel so a stray Enter (for example while typing in a terminal) never accepts them
  const guarded = $derived(!modal.fields.length && (!!modal.danger || !!modal.choices?.[0]?.danger))

  function close(ok: boolean, choice?: string): void {
    const { id, resolve } = modal
    resolve(ok ? { values: $state.snapshot(values), checked, choice } : null)
    app.dropModal(id)
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close(false)} />

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && close(false)}>
  <form
    class={['modal', modal.danger && 'danger']}
    onsubmit={(e) => {
      e.preventDefault()
      close(true)
    }}
  >
    <h2>{modal.title}</h2>
    {#if modal.message}<p class="message">{modal.message}</p>{/if}
    {#if modal.detail}<pre class="mono-block">{modal.detail}</pre>{/if}
    {#each modal.fields as field, i (field.name)}
      <label class="field">
        <span class="label">{field.label}</span>
        <input
          class="input"
          type={field.secret ? 'password' : 'text'}
          bind:value={values[field.name]}
          {@attach focusOnMount(i === 0)}
          autocomplete="off"
          spellcheck="false"
        />
      </label>
    {/each}
    {#if modal.checkbox}
      <Checkbox label={modal.checkbox.label} bind:checked />
    {/if}
    <div class="actions">
      <button type="button" class="btn ghost" onclick={() => close(false)} {@attach focusOnMount(guarded)}>Cancel</button>
      {#if modal.choices}
        {#each modal.choices as c, i (c.id)}
          <button
            type="button"
            class={['btn', i === 0 && 'strong', c.danger && 'danger']}
            onclick={() => close(true, c.id)}
            {@attach focusOnMount(i === 0 && !guarded)}>{c.label}</button
          >
        {/each}
      {:else}
        <button type="submit" class={['btn', 'strong', modal.danger && 'danger']} {@attach focusOnMount(!modal.fields.length && !guarded)}>
          {modal.confirmLabel}
        </button>
      {/if}
    </div>
  </form>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    background: oklch(0 0 0 / 0.45);
  }
  .modal {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(480px, calc(100vw - 48px));
    padding: 24px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg);
    box-shadow: var(--shadow);
  }
  .modal.danger {
    border-color: color-mix(in srgb, var(--danger) 50%, transparent);
  }
  .message {
    line-height: 1.7;
  }
  pre {
    margin: 0;
    font: inherit;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }
</style>
