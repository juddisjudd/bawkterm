<script lang="ts">
  import Search from '@lucide/svelte/icons/search'
  import Plus from '@lucide/svelte/icons/plus'
  import Pencil from '@lucide/svelte/icons/pencil'
  import type { AdhocTarget, Host } from '@shared/types'
  import { app, type MenuItem } from '$lib/state.svelte'
  import { ago } from '$lib/format'
  import PageHeader from './PageHeader.svelte'
  import HostEditor from './HostEditor.svelte'

  const vault = $derived(app.vault!)
  let query = $state('')
  let quick = $state('')
  const QUICK_MODES = ['ssh', 'sftp', 'docker', 'rdp'] as const
  let quickMode = $state<(typeof QUICK_MODES)[number]>('ssh')

  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const hosts = vault.hosts.filter(
      (h) => !q || [h.label, h.address, h.username, h.group, ...h.tags].some((v) => v.toLowerCase().includes(q))
    )
    const map = new Map<string, Host[]>()
    for (const h of hosts) map.set(h.group, [...(map.get(h.group) ?? []), h])
    return [...map.entries()]
      .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
      .map(([name, list]) => ({ name, hosts: list.sort((a, b) => a.label.localeCompare(b.label)) }))
  })

  function auth(h: Host): string[] {
    const identity = h.identityId ? vault.identities.find((i) => i.id === h.identityId) : undefined
    const out: string[] = []
    if (identity) out.push(`@${identity.label}`)
    if (h.keyId) out.push('key')
    if (h.password) out.push('pw')
    if (h.useAgent && h.kind === 'ssh') out.push('agent')
    if (h.jumpHostId) out.push('jump')
    return out
  }

  function userAt(h: Host): string {
    const identity = h.identityId ? vault.identities.find((i) => i.id === h.identityId) : undefined
    const user = h.username || identity?.username
    const defaultPort = h.kind === 'rdp' ? 3389 : 22
    return `${user ? `${user}@` : ''}${h.address}${h.port !== defaultPort ? `:${h.port}` : ''}`
  }

  function parseQuick(text: string, defaultPort: number): AdhocTarget | null {
    const m = text.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^\s:@]+)(?::(\d+))?(?:\s+-p\s*(\d+))?$/)
    if (!m) return null
    return { username: m[1] ?? '', address: m[2], port: Number(m[4] ?? m[3] ?? defaultPort) }
  }

  function connectQuick(e: SubmitEvent): void {
    e.preventDefault()
    const target = parseQuick(quick, quickMode === 'rdp' ? 3389 : 22)
    if (!target) {
      app.toast('Use the form user@host or user@host:port', 'error')
      return
    }
    const title = target.username ? `${target.username}@${target.address}` : target.address
    if (quickMode === 'rdp') void app.launchRdp({ adhoc: target }, title)
    else app.openTab(quickMode, { adhoc: target }, title)
    quick = ''
  }

  async function importConfig(): Promise<void> {
    try {
      const res = await window.api.importSshConfig()
      app.toast(`Imported ${res.hosts} hosts and ${res.keys} keys${res.skipped.length ? `, skipped ${res.skipped.length}` : ''}`)
    } catch (err) {
      app.fail(err)
    }
  }

  async function remove(h: Host): Promise<void> {
    if (!(await app.confirm('Delete host', `Delete "${h.label || h.address}" from the vault?`))) return
    await window.api.hosts.remove(h.id).catch((err) => app.fail(err))
  }

  async function duplicate(h: Host): Promise<void> {
    const copy = { ...h, id: '', label: `${h.label} copy`, lastUsedAt: undefined, createdAt: Date.now() }
    await window.api.hosts.save(copy).catch((err) => app.fail(err))
  }

  function menu(e: MouseEvent, h: Host): void {
    const open: MenuItem[] =
      h.kind === 'rdp'
        ? [{ label: 'Open Remote Desktop', action: () => app.launchRdp({ hostId: h.id }, h.label || h.address) }]
        : [
            { label: 'Open SSH', action: () => app.openHost('ssh', h.id) },
            { label: 'Open SFTP', action: () => app.openHost('sftp', h.id) },
            { label: 'Open Docker', action: () => app.openHost('docker', h.id) }
          ]
    app.openMenu(e, [
      ...open,
      'sep',
      { label: 'Edit', action: () => (app.editingHost = h.id) },
      { label: 'Duplicate', action: () => duplicate(h) },
      { label: 'Copy address', action: () => navigator.clipboard.writeText(h.address) },
      'sep',
      { label: 'Delete', danger: true, action: () => remove(h) }
    ])
  }
</script>

<div class="page">
  <PageHeader title="hosts" subtitle={`${vault.hosts.length} saved`}>
    {#snippet actions()}
      <button type="button" class="btn" onclick={importConfig}>Import ~/.ssh/config</button>
      <button type="button" class="btn strong" onclick={() => (app.editingHost = '')}><Plus /> New host</button>
    {/snippet}
  </PageHeader>

  <form class="quick" onsubmit={connectQuick}>
    <div class="modes" role="tablist">
      {#each QUICK_MODES as mode (mode)}
        <button
          type="button"
          role="tab"
          aria-selected={quickMode === mode}
          class:active={quickMode === mode}
          onclick={() => (quickMode = mode)}>{mode}</button
        >
      {/each}
    </div>
    <div class="line">
      <span class="dollar">$</span>
      <span class="cmd">{quickMode}</span>
      <input bind:value={quick} placeholder="user@host:port" spellcheck="false" autocomplete="off" />
      <button type="submit" class="btn small strong" disabled={!quick.trim()}>connect</button>
    </div>
  </form>

  <label class="search">
    <Search size={14} />
    <input bind:value={query} placeholder="filter by name, address, user, group or tag" spellcheck="false" />
  </label>

  {#if !vault.hosts.length}
    <div class="empty">
      <p class="strong">[ ] no hosts yet</p>
      <p class="muted">Add a host, import your ~/.ssh/config, or type user@host above to connect once.</p>
    </div>
  {/if}

  {#each groups as group (group.name)}
    <section>
      {#if group.name || groups.length > 1}
        <h3>{group.name || 'ungrouped'} <span class="muted">({group.hosts.length})</span></h3>
      {/if}
      <ul>
        {#each group.hosts as h (h.id)}
          <li
            class="host"
            ondblclick={() => app.openHost('ssh', h.id)}
            oncontextmenu={(e) => menu(e, h)}
          >
            <span class="marker">{h.kind === 'rdp' ? '[#]' : '[>]'}</span>
            <span class="label">{h.label || h.address}</span>
            <span class="addr">{userAt(h)}</span>
            <span class="tags">
              {#if h.kind === 'rdp'}<span class="tag">rdp</span>{/if}
              {#each auth(h) as a (a)}<span class="tag">{a}</span>{/each}
              {#each h.tags as t (t)}<span class="tag">#{t}</span>{/each}
            </span>
            <span class="used" title="last connected">{ago(h.lastUsedAt)}</span>
            <span class="actions">
              {#if h.kind === 'rdp'}
                <button type="button" class="btn small" onclick={() => app.launchRdp({ hostId: h.id }, h.label || h.address)}
                  >remote desktop</button
                >
              {:else}
                <button type="button" class="btn small" onclick={() => app.openHost('ssh', h.id)}>ssh</button>
                <button type="button" class="btn small" onclick={() => app.openHost('sftp', h.id)}>sftp</button>
                <button type="button" class="btn small" onclick={() => app.openHost('docker', h.id)}>docker</button>
              {/if}
              <button
                type="button"
                class="btn small icon ghost"
                aria-label="Edit host"
                onclick={() => (app.editingHost = h.id)}><Pencil /></button
              >
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {:else}
    {#if vault.hosts.length}<p class="muted">No hosts match "{query}".</p>{/if}
  {/each}
</div>

{#if app.editingHost !== null}
  {#key app.editingHost}
    <HostEditor hostId={app.editingHost} onclose={() => (app.editingHost = null)} />
  {/key}
{/if}

<style>
  .page {
    padding: 32px 40px 64px;
  }
  .quick {
    margin-bottom: 24px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg-weak);
  }
  .modes {
    display: flex;
    gap: 28px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border-weak);
  }
  .modes button {
    padding: 10px 0;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-weak);
    cursor: pointer;
  }
  .modes button.active {
    border-bottom-color: var(--bg-strong);
    color: var(--text-strong);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px 10px 16px;
    font-size: 14px;
  }
  .dollar {
    color: var(--text-weak);
  }
  .cmd {
    color: var(--text-strong);
    font-weight: 500;
  }
  .line input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--text-strong);
    font: inherit;
    outline: none;
  }
  .line input::placeholder {
    color: var(--text-weaker);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    padding: 0 2px 8px;
    border-bottom: 1px solid var(--border-weak);
    color: var(--text-weak);
  }
  .search input {
    flex: 1;
    border: 0;
    background: none;
    color: var(--text-strong);
    font: inherit;
    outline: none;
  }
  .search input::placeholder {
    color: var(--text-weaker);
  }
  section {
    margin-bottom: 24px;
  }
  h3 {
    margin: 0 0 8px;
    color: var(--text-strong);
    font-size: 12px;
    font-weight: 500;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
  }
  .host {
    display: grid;
    grid-template-columns: 32px minmax(120px, 1.2fr) minmax(140px, 1.4fr) minmax(0, 1fr) 72px 222px;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 0 12px;
    border-top: 1px solid var(--border-weak);
    cursor: default;
  }
  .host:first-child {
    border-top: 0;
  }
  .host:hover {
    background: var(--bg-weak);
  }
  .marker {
    color: var(--text-weaker);
  }
  .host:hover .marker {
    color: var(--text-strong);
  }
  .label {
    overflow: hidden;
    color: var(--text-strong);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .addr {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tags {
    display: flex;
    gap: 6px;
    overflow: hidden;
  }
  .tag {
    color: var(--text-weak);
    font-size: 12px;
    white-space: nowrap;
  }
  .used {
    color: var(--text-weak);
    font-size: 12px;
    text-align: right;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    opacity: 0;
  }
  .host:hover .actions,
  .host:focus-within .actions {
    opacity: 1;
  }
  .empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 32px;
    border: 1px dashed var(--border-weak);
    border-radius: var(--radius-lg);
  }
</style>
