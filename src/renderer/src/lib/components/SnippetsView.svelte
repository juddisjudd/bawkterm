<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus'
  import type { Snippet } from '@shared/types'
  import { app, tabName } from '$lib/state.svelte'
  import { terminalFor } from '$lib/sessions'
  import { MOD } from '$lib/keys'
  import PageHeader from './PageHeader.svelte'
  import SnippetEditor from './SnippetEditor.svelte'

  const vault = $derived(app.vault!)
  const list = $derived([...vault.snippets].sort((a, b) => a.label.localeCompare(b.label)))
  const terminals = $derived(app.tabs.filter((t) => t.kind === 'ssh' && t.status === 'connected'))
  let editing = $state<string | null>(null)

  function runIn(tabId: string, snippet: Snippet): void {
    terminalFor(tabId)?.run(snippet.command)
    app.active = tabId
  }

  async function remove(s: Snippet): Promise<void> {
    if (await app.confirm('Delete snippet', `Delete "${s.label}"?`)) {
      await window.api.snippets.remove(s.id).catch((err) => app.fail(err))
    }
  }

  function menu(e: MouseEvent, s: Snippet): void {
    app.openMenu(e, [
      ...terminals.map((t) => ({ label: `Run in ${tabName(t)}`, action: () => runIn(t.id, s) })),
      ...(terminals.length ? ['sep' as const] : []),
      { label: 'Edit', action: () => (editing = s.id) },
      { label: 'Copy command', action: () => navigator.clipboard.writeText(s.command) },
      'sep',
      { label: 'Delete', danger: true, action: () => remove(s) }
    ])
  }
</script>

<div class="page">
  <PageHeader title="snippets" subtitle="Saved commands. Run one in the open terminal with {MOD}+Shift+S.">
    {#snippet actions()}
      <button type="button" class="btn strong" onclick={() => (editing = '')}><Plus /> New snippet</button>
    {/snippet}
  </PageHeader>

  {#if list.length}
    <ul>
      {#each list as s (s.id)}
        <li oncontextmenu={(e) => menu(e, s)} ondblclick={() => (editing = s.id)}>
          <div class="head">
            <span class="label">{s.label}</span>
            <span class="actions">
              {#if terminals.length === 1}
                <button type="button" class="btn small" onclick={() => runIn(terminals[0].id, s)}>run in {terminals[0].title}</button>
              {:else if terminals.length > 1}
                <button type="button" class="btn small" onclick={(e) => menu(e, s)}>run in…</button>
              {/if}
              <button type="button" class="btn small ghost" onclick={() => (editing = s.id)}>edit</button>
              <button type="button" class="btn small ghost danger" onclick={() => remove(s)}>delete</button>
            </span>
          </div>
          <pre class="command selectable"><span class="dollar">$ </span>{s.command}</pre>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="empty">
      <p class="strong">[ ] no snippets yet</p>
      <p class="muted">Save commands you type often, like <code>sudo systemctl restart nginx</code> or a deploy script.</p>
    </div>
  {/if}
</div>

{#if editing !== null}
  {#key editing}
    <SnippetEditor snippetId={editing} onclose={() => (editing = null)} />
  {/key}
{/if}

<style>
  .page {
    padding: 32px 40px 64px;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    padding: 12px 14px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
  }
  li:hover {
    background: var(--bg-weak);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }
  .label {
    color: var(--text-strong);
    font-weight: 500;
  }
  .actions {
    display: flex;
    gap: 4px;
  }
  .command {
    margin: 0;
    max-height: 120px;
    overflow: auto;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .dollar {
    color: var(--text-weak);
  }
  code {
    color: var(--text-strong);
    font: inherit;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 28px;
    border: 1px dashed var(--border-weak);
    border-radius: var(--radius-lg);
  }
</style>
