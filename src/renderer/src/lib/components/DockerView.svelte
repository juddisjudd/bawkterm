<script lang="ts">
  import { onMount } from 'svelte'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Search from '@lucide/svelte/icons/search'
  import type { ContainerInfo, ContainerStats, DockerAction, DockerCommand } from '@shared/types'
  import { app, type Tab } from '$lib/state.svelte'
  import { Reconnector } from '$lib/reconnect.svelte'

  let { tab, active }: { tab: Tab; active: boolean } = $props()

  const api = window.api
  let containers = $state.raw<ContainerInfo[]>([])
  let stats = $state.raw<Record<string, ContainerStats>>({})
  let version = $state('')
  let error = $state('')
  let loading = $state(false)
  let query = $state('')
  let busy = $state<string | null>(null)

  const connected = $derived(tab.status === 'connected')
  const reconnect = new Reconnector(() => void connect())

  $effect(() => void reconnect.track(tab.status, tab.dropped, tab.message, app.settings.autoReconnect))

  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const list = containers.filter((c) => !q || [c.name, c.image, c.project, c.service].some((v) => v.toLowerCase().includes(q)))
    const map = new Map<string, ContainerInfo[]>()
    for (const c of list) map.set(c.project, [...(map.get(c.project) ?? []), c])
    return [...map.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([name, items]) => ({
        name,
        items: items.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name))
      }))
  })
  const running = $derived(containers.filter((c) => c.state === 'running').length)

  function ports(raw: string): string {
    const seen = new Set<string>()
    for (const part of raw.split(', ')) {
      const published = part.match(/:(\d+)->(\d+)\/(\w+)/)
      const text = published ? `${published[1]}→${published[2]}` : part.replace(/\/tcp$/, '')
      if (text) seen.add(text)
    }
    return [...seen].join(' ')
  }

  async function refresh(withStats = true): Promise<void> {
    if (!connected || loading) return
    loading = true
    try {
      containers = await api.docker.list(tab.id)
      error = ''
      if (withStats && containers.some((c) => c.state === 'running')) {
        stats = Object.fromEntries((await api.docker.stats(tab.id)).map((s) => [s.id, s]))
      }
    } catch (err) {
      error = (err as Error).message
    } finally {
      loading = false
    }
  }

  async function connect(): Promise<void> {
    app.updateTab({ sessionId: tab.id, status: 'connecting' })
    try {
      const res = await api.docker.open(tab.id, $state.snapshot(tab.target))
      version = res.version
      await refresh()
    } catch {
      // status event carries the error
    }
  }

  async function open(c: ContainerInfo, kind: DockerCommand): Promise<void> {
    try {
      const command = await api.docker.command(tab.id, c.id, kind)
      app.openTab('ssh', $state.snapshot(tab.target), `${c.name} · ${kind}`, command)
    } catch (err) {
      app.fail(err)
    }
  }

  async function act(c: ContainerInfo, action: DockerAction): Promise<void> {
    if (action !== 'start') {
      const ok = await app.confirm(
        `${action === 'stop' ? 'Stop' : 'Restart'} container`,
        `${action === 'stop' ? 'Stop' : 'Restart'} "${c.name}" on ${tab.title}?`,
        action === 'stop' ? 'Stop' : 'Restart'
      )
      if (!ok) return
    }
    busy = c.id
    try {
      await api.docker.action(tab.id, c.id, action)
      app.toast(`${c.name}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`)
      await refresh()
    } catch (err) {
      app.fail(err)
    } finally {
      busy = null
    }
  }

  function menu(e: MouseEvent, c: ContainerInfo): void {
    const up = c.state === 'running'
    app.openMenu(e, [
      { label: 'Open shell', action: () => open(c, 'shell'), disabled: !up },
      { label: 'Follow logs', action: () => open(c, 'logs') },
      'sep',
      up ? { label: 'Restart', action: () => act(c, 'restart') } : { label: 'Start', action: () => act(c, 'start') },
      { label: 'Stop', action: () => act(c, 'stop'), danger: true, disabled: !up },
      'sep',
      { label: 'Copy name', action: () => navigator.clipboard.writeText(c.name) },
      { label: 'Copy id', action: () => navigator.clipboard.writeText(c.id) }
    ])
  }

  onMount(() => {
    void connect()
    let tick = 0
    const timer = setInterval(() => {
      if (!active || !connected) return
      tick++
      void refresh(tick % 3 === 0)
    }, 5000)
    return () => {
      clearInterval(timer)
      reconnect.dispose()
      void api.docker.close(tab.id)
    }
  })
</script>

<div class="docker">
  <header>
    <div class="title">
      <span class="side">docker</span>
      <span class="name">{tab.title}</span>
      {#if version}<span class="muted">v{version}</span>{/if}
      {#if connected}<span class="muted">· {running}/{containers.length} running</span>{/if}
    </div>
    <label class="search">
      <Search size={14} />
      <input bind:value={query} placeholder="filter containers" spellcheck="false" />
    </label>
    <button type="button" class="btn small icon ghost" aria-label="Refresh" disabled={!connected} onclick={() => refresh()}>
      <RefreshCw class={loading ? 'spin' : ''} />
    </button>
  </header>

  {#if tab.status === 'connecting'}
    <p class="state"><span class="dot connecting"></span> {reconnect.state ? `reconnecting (attempt ${reconnect.state.attempt})…` : (tab.message ?? `connecting to ${tab.title}`)}</p>
  {:else if reconnect.state}
      <div class="state">
        <p class="strong"><span class="dot connecting"></span> connection lost</p>
        <p class="muted">retrying in {reconnect.state.seconds}s (attempt {reconnect.state.attempt})</p>
        <div class="actions">
          <button type="button" class="btn small strong" onclick={() => reconnect.now()}>Retry now</button>
          <button type="button" class="btn small ghost" onclick={() => reconnect.stop()}>Stop</button>
        </div>
      </div>
    {:else if tab.status === 'error' || tab.status === 'closed'}
    <div class="state">
      <p><span class={['dot', tab.status]}></span> {tab.message ?? 'disconnected'}</p>
      <div class="actions">
        <button type="button" class="btn small strong" onclick={connect}>Reconnect</button>
        <button type="button" class="btn small ghost" onclick={() => app.closeTab(tab.id)}>Close tab</button>
      </div>
    </div>
  {:else if error}
    <p class="state error selectable">{error}</p>
  {:else if !containers.length && !loading}
    <p class="state muted">No containers on this host.</p>
  {/if}

  {#if connected}
    <div class="list">
      {#each groups as group (group.name)}
        <section>
          <h3>{group.name || 'standalone'} <span class="muted">({group.items.length})</span></h3>
          <ul>
            {#each group.items as c (c.id)}
              {@const s = stats[c.id]}
              {@const up = c.state === 'running'}
              <li oncontextmenu={(e) => menu(e, c)} ondblclick={() => up && open(c, 'shell')}>
                <span class={['dot', up ? 'connected' : c.state === 'restarting' ? 'connecting' : c.state === 'exited' ? 'error' : '']}></span>
                <span class="cname" title={c.id}>{c.name}</span>
                <span class="image" title={c.image}>{c.image}</span>
                <span class="status">{c.status}</span>
                <span class="ports" title={c.ports}>{ports(c.ports)}</span>
                <span class="usage">{up && s ? `${s.cpu} · ${s.mem.split(' / ')[0]}` : ''}</span>
                <span class="row-actions">
                  <button type="button" class="btn small" disabled={!up} onclick={() => open(c, 'shell')}>shell</button>
                  <button type="button" class="btn small" onclick={() => open(c, 'logs')}>logs</button>
                  {#if up}
                    <button type="button" class="btn small ghost" disabled={busy === c.id} onclick={() => act(c, 'restart')}>restart</button>
                    <button type="button" class="btn small ghost danger" disabled={busy === c.id} onclick={() => act(c, 'stop')}>stop</button>
                  {:else}
                    <button type="button" class="btn small ghost" disabled={busy === c.id} onclick={() => act(c, 'start')}>start</button>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .docker {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 16px 20px;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }
  .side {
    color: var(--text-weak);
    font-size: 11px;
  }
  .name {
    color: var(--text-strong);
    font-weight: 500;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 260px;
    padding: 0 10px;
    height: 30px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    background: var(--bg-weak);
    color: var(--text-weak);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--text-strong);
    font: inherit;
    outline: none;
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 0;
  }
  .state p {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  p.state {
    flex-direction: row;
    align-items: center;
  }
  .error {
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  section {
    margin-bottom: 20px;
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
  li {
    display: grid;
    grid-template-columns: 10px minmax(120px, 1.3fr) minmax(120px, 1.4fr) minmax(90px, 1fr) minmax(70px, 0.9fr) 150px 236px;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    padding: 0 10px 0 14px;
    border-top: 1px solid var(--border-weak);
    font-size: 12px;
  }
  li:first-child {
    border-top: 0;
  }
  li:hover {
    background: var(--bg-weak);
  }
  .cname {
    overflow: hidden;
    color: var(--text-strong);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .image,
  .status,
  .ports,
  .usage {
    overflow: hidden;
    color: var(--text-weak);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-actions {
    display: flex;
    gap: 4px;
    justify-content: flex-end;
  }
</style>
