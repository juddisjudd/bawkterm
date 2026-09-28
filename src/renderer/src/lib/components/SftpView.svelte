<script lang="ts">
  import { onMount } from 'svelte'
  import Star from '@lucide/svelte/icons/star'
  import type { FileEntry } from '@shared/types'
  import { app, type Tab } from '$lib/state.svelte'
  import { localPath, remotePath } from '$lib/paths'
  import FilePane from './FilePane.svelte'
  import Transfers from './Transfers.svelte'
  import Edits from './Edits.svelte'
  import { Reconnector } from '$lib/reconnect.svelte'

  let { tab }: { tab: Tab } = $props()

  const api = window.api
  let local = $state('')
  let remote = $state('')
  // svelte-ignore state_referenced_locally
  let remoteTitle = $state(tab.title)
  let localPane = $state<ReturnType<typeof FilePane>>()
  let remotePane = $state<ReturnType<typeof FilePane>>()

  const connected = $derived(tab.status === 'connected')
  const reconnect = new Reconnector(() => void connect())

  $effect(() => void reconnect.track(tab.status, tab.dropped, tab.message, app.settings.autoReconnect))
  const target = $derived(tab.target)
  const host = $derived('hostId' in target ? app.vault?.hosts.find((h) => h.id === target.hostId) : undefined)
  const pathKey = $derived('hostId' in target ? target.hostId : `adhoc:${target.adhoc.username}@${target.adhoc.address}:${target.adhoc.port}`)
  const bookmarked = $derived(!!host?.bookmarks.includes(remote))

  $effect(() => app.rememberPath(pathKey, remote))
  $effect(() => app.rememberPath('local', local))

  const quote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`

  function openTerminal(path: string): void {
    const name = path.split('/').filter(Boolean).pop() ?? '/'
    app.openTab('ssh', $state.snapshot(tab.target), `${remoteTitle} · ${name}`, `cd ${quote(path)} && exec "\${SHELL:-/bin/sh}" -l`)
  }

  async function toggleBookmark(): Promise<void> {
    if (!host) return
    const bookmarks = bookmarked ? host.bookmarks.filter((b) => b !== remote) : [...host.bookmarks, remote]
    await api.hosts.save({ ...host, bookmarks }).catch((err) => app.fail(err))
  }

  function bookmarkMenu(e: MouseEvent): void {
    if (!host) return
    app.openMenu(
      e,
      host.bookmarks.map((b) => ({ label: b, action: () => (remote = b) }))
    )
  }

  async function connect(): Promise<void> {
    app.updateTab({ sessionId: tab.id, status: 'connecting' })
    try {
      const res = await api.sftp.open(tab.id, $state.snapshot(tab.target))
      remoteTitle = res.title
      if (!remote) {
        const last = app.vault?.local.lastPaths[pathKey]
        remote = last ? await api.sftp.realpath(tab.id, last).catch(() => res.home) : res.home
      }
    } catch {
      // status event carries the error
    }
  }

  function upload(paths: string[]): void {
    if (!connected) return
    api.sftp.upload(tab.id, paths, remote).catch((err) => app.fail(err))
  }

  function download(paths: string[]): void {
    if (!connected) return
    if (!local) {
      app.toast('Open a local folder first', 'error')
      return
    }
    api.sftp.download(tab.id, paths, local).catch((err) => app.fail(err))
  }

  onMount(() => {
    void api.local.home().then((home) => (local = local || app.vault?.local.lastPaths['local'] || home))
    void connect()
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = api.sftp.onTransfer((info) => {
      if (info.sessionId !== tab.id || (info.state !== 'done' && info.state !== 'cancelled')) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (info.direction === 'upload') remotePane?.refresh()
        else localPane?.refresh()
      }, 150)
    })
    return () => {
      stop()
      clearTimeout(timer)
      reconnect.dispose()
      void api.sftp.close(tab.id)
    }
  })
</script>

  {#snippet bookmarkTools()}
    <button
      type="button"
      class="btn small icon ghost"
      aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this folder'}
      title={bookmarked ? 'Remove bookmark' : 'Bookmark this folder'}
      disabled={!connected}
      onclick={toggleBookmark}
    >
      <Star size={14} fill={bookmarked ? 'currentColor' : 'none'} color={bookmarked ? 'var(--warning)' : 'currentColor'} />
    </button>
    {#if host?.bookmarks.length}
      <button type="button" class="btn small ghost" disabled={!connected} onclick={bookmarkMenu}>bookmarks</button>
    {/if}
  {/snippet}

  {#snippet connectionState()}
    {#if tab.status === 'connecting'}
      <div class="panel">
        <p class="strong"><span class="dot connecting"></span> {reconnect.state ? `reconnecting (attempt ${reconnect.state.attempt})` : `connecting to ${tab.title}`}</p>
        <p class="muted">{tab.message ?? 'opening sftp channel…'}</p>
      </div>
    {:else if reconnect.state}
      <div class="panel">
        <p class="strong"><span class="dot connecting"></span> connection lost</p>
        <p class="muted">retrying in {reconnect.state.seconds}s (attempt {reconnect.state.attempt})</p>
        <div class="actions">
          <button type="button" class="btn small strong" onclick={() => reconnect.now()}>Retry now</button>
          <button type="button" class="btn small ghost" onclick={() => reconnect.stop()}>Stop</button>
        </div>
      </div>
    {:else if tab.status === 'error' || tab.status === 'closed'}
      <div class="panel">
        <p class="strong"><span class={['dot', tab.status]}></span> {tab.status === 'error' ? 'could not connect' : 'disconnected'}</p>
        {#if tab.message}<p class="muted selectable">{tab.message}</p>{/if}
        <div class="actions">
          <button type="button" class="btn small strong" onclick={connect}>Reconnect</button>
          <button type="button" class="btn small ghost" onclick={() => app.closeTab(tab.id)}>Close tab</button>
        </div>
      </div>
    {/if}
  {/snippet}

<div class="sftp">
  <div class="panes">
    <FilePane
      bind:this={localPane}
      side="local"
      title="this computer"
      ops={localPath}
      bind:path={local}
      showHidden={app.settings.sftpShowHidden}
      sendLabel="Upload"
      list={(p) => api.local.list(p)}
      onsend={(entries: FileEntry[]) => upload(entries.map((e) => e.path))}
      onreceive={(paths) => download(paths)}
      onmkdir={(p) => api.local.mkdir(p)}
      onrename={(a, b) => api.local.rename(a, b)}
      onremove={(entries) => api.local.trash(entries.map((e) => e.path))}
      onopen={(e) => api.local.open(e.path).catch((err) => app.fail(err))}
    />
    <FilePane
      bind:this={remotePane}
      side="remote"
      title={remoteTitle}
      ops={remotePath}
      bind:path={remote}
      showHidden={app.settings.sftpShowHidden}
      disabled={!connected}
      sendLabel="Download"
      list={(p) => api.sftp.list(tab.id, p)}
      onsend={(entries: FileEntry[]) => download(entries.map((e) => e.path))}
      onreceive={(paths) => upload(paths)}
      onmkdir={(p) => api.sftp.mkdir(tab.id, p)}
      onrename={(a, b) => api.sftp.rename(tab.id, a, b)}
      onremove={(entries) => api.sftp.remove(tab.id, entries.map((e) => e.path))}
      onedit={(e) => api.sftp.edit(tab.id, e.path).catch((err) => app.fail(err))}
      onterminal={openTerminal}
      tools={host ? bookmarkTools : undefined}
      overlay={connected ? undefined : connectionState}
    />
  </div>
  <Edits sessionId={tab.id} />
  <Transfers sessionId={tab.id} />
</div>

<style>
  .sftp {
    display: flex;
    flex-direction: column;
    gap: 10px;
    height: 100%;
    padding: 12px;
  }
  .panes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    flex: 1;
    min-height: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    max-width: 80%;
    padding: 18px 20px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg);
  }
  .panel p {
    display: flex;
    align-items: center;
    gap: 10px;
    line-height: 1.6;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
</style>
