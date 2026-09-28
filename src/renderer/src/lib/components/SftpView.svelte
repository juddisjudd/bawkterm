<script lang="ts">
  import { onMount } from 'svelte'
  import type { FileEntry } from '@shared/types'
  import { app, type Tab } from '$lib/state.svelte'
  import { localPath, remotePath } from '$lib/paths'
  import FilePane from './FilePane.svelte'
  import Transfers from './Transfers.svelte'

  let { tab }: { tab: Tab } = $props()

  const api = window.api
  let local = $state('')
  let remote = $state('')
  // svelte-ignore state_referenced_locally
  let remoteTitle = $state(tab.title)
  let localPane = $state<ReturnType<typeof FilePane>>()
  let remotePane = $state<ReturnType<typeof FilePane>>()

  const connected = $derived(tab.status === 'connected')

  async function connect(): Promise<void> {
    app.updateTab({ sessionId: tab.id, status: 'connecting' })
    try {
      const res = await api.sftp.open(tab.id, $state.snapshot(tab.target))
      remoteTitle = res.title
      remote = remote || res.home
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
    void api.local.home().then((home) => (local = local || home))
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
      void api.sftp.close(tab.id)
    }
  })
</script>

  {#snippet connectionState()}
    {#if tab.status === 'connecting'}
      <div class="panel">
        <p class="strong"><span class="dot connecting"></span> connecting to {tab.title}</p>
        <p class="muted">{tab.message ?? 'opening sftp channel…'}</p>
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
      overlay={connected ? undefined : connectionState}
    />
  </div>
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
