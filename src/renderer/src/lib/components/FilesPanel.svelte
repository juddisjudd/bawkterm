<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import LocateFixed from '@lucide/svelte/icons/locate-fixed'
  import SquareTerminal from '@lucide/svelte/icons/square-terminal'
  import Upload from '@lucide/svelte/icons/upload'
  import X from '@lucide/svelte/icons/x'
  import type { FileEntry, SessionStatus } from '@shared/types'
  import { app, filesSession, FILES_MIN_WIDTH, type Tab } from '$lib/state.svelte'
  import { remotePath } from '$lib/paths'
  import { resolveCwd } from '$lib/cwd'
  import { shellSafeLabel } from '$lib/keys'
  import FilePane from './FilePane.svelte'
  import Transfers from './Transfers.svelte'
  import Edits from './Edits.svelte'

  let { tab, oncd }: { tab: Tab; oncd: (path: string) => void } = $props()

  const api = window.api
  const FOLLOW_HELP = 'https://github.com/juddisjudd/bawkterm#files-beside-the-terminal'
  // svelte-ignore state_referenced_locally
  const sid = filesSession(tab.id)
  let status = $state<SessionStatus | 'idle'>('idle')
  let message = $state('')
  let title = $state('')
  let remote = $state('')
  let follow = $state(true)
  let width = $state(app.filesWidth)
  let home = $state('')
  let pane = $state<ReturnType<typeof FilePane>>()

  const terminalUp = $derived(tab.status === 'connected')
  const connected = $derived(terminalUp && status === 'connected')

  async function attach(): Promise<void> {
    status = 'connecting'
    message = ''
    try {
      const res = await api.sftp.attach(sid, tab.id)
      home = res.home
      title = res.title
      remote = (follow && tab.cwd ? resolveCwd(tab.cwd, home) : remote) || home
      status = 'connected'
    } catch (err) {
      status = 'error'
      message = (err as Error).message
    }
  }

  onMount(() => {
    const stopStatus = api.sftp.onStatus((e) => {
      if (e.sessionId !== sid) return
      status = e.status
      message = e.message ?? ''
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopTransfer = api.sftp.onTransfer((info) => {
      if (info.sessionId !== sid || info.direction !== 'upload' || (info.state !== 'done' && info.state !== 'cancelled')) return
      clearTimeout(timer)
      timer = setTimeout(() => pane?.refresh(), 150)
    })
    return () => {
      stopStatus()
      stopTransfer()
      clearTimeout(timer)
      void api.sftp.close(sid)
    }
  })

  // a dropped terminal takes this channel with it; it comes back when the terminal reconnects
  $effect(() => {
    const up = terminalUp
    untrack(() => {
      if (!up) status = 'idle'
      else if (status === 'idle' || status === 'closed') void attach()
    })
  })

  $effect(() => {
    if (follow && tab.cwd && home && status === 'connected') remote = resolveCwd(tab.cwd, home)
  })

  function upload(paths: string[]): void {
    if (!connected || !paths.length) return
    api.sftp.upload(sid, paths, remote).catch((err) => app.fail(err))
  }

  async function download(entries: FileEntry[]): Promise<void> {
    if (!connected || !entries.length) return
    const dir = await api.local.downloads()
    api.sftp.download(sid, entries.map((e) => e.path), dir).catch((err) => app.fail(err))
    app.toast(`Downloading to ${dir}`)
  }

  function resize(e: PointerEvent): void {
    const grip = e.currentTarget as HTMLElement
    const start = e.clientX
    const from = width
    grip.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent): void => {
      width = Math.max(FILES_MIN_WIDTH, from + start - m.clientX)
    }
    const up = (): void => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      app.filesWidth = width
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  }

  function nudge(e: KeyboardEvent): void {
    const step = { ArrowLeft: 16, ArrowRight: -16 }[e.key]
    if (!step) return
    e.preventDefault()
    width = Math.max(FILES_MIN_WIDTH, width + step)
    app.filesWidth = width
  }
</script>

{#snippet tools()}
  <button
    type="button"
    class={['btn small icon ghost', follow && 'on']}
    aria-pressed={follow}
    aria-label="Follow the terminal folder"
    title={follow ? 'Following the terminal folder' : 'Follow the terminal folder'}
    onclick={() => (follow = !follow)}><LocateFixed /></button
  >
  <button
    type="button"
    class="btn small icon ghost"
    aria-label="cd here in the terminal"
    title="cd here in the terminal"
    disabled={!connected}
    onclick={() => oncd(remote)}><SquareTerminal /></button
  >
  <button
    type="button"
    class="btn small icon ghost"
    aria-label="Upload files"
    title="Upload files"
    disabled={!connected}
    onclick={async () => upload(await api.local.pickFiles())}><Upload /></button
  >
  <button
    type="button"
    class="btn small icon ghost"
    aria-label="Hide files"
    title="Hide files ({shellSafeLabel('B')})"
    onclick={() => app.toggleFiles(tab.id)}><X /></button
  >
{/snippet}

{#snippet connectionState()}
  <div class="panel">
    {#if !terminalUp}
      <p class="muted">waiting for the terminal to connect</p>
    {:else if status === 'connecting' || status === 'idle'}
      <p class="muted"><span class="dot connecting"></span> opening files…</p>
    {:else}
      <p class="strong"><span class={['dot', status]}></span> {status === 'error' ? 'could not open files' : 'files closed'}</p>
      {#if message}<p class="muted selectable">{message}</p>{/if}
      <button type="button" class="btn small strong" onclick={attach}>Retry</button>
    {/if}
  </div>
{/snippet}

<aside class="files" style:width="{width}px">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="grip"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    aria-label="Resize files"
    onpointerdown={resize}
    onkeydown={nudge}
  ></div>
  <FilePane
    bind:this={pane}
    side="remote"
    title={title || tab.title}
    ops={remotePath}
    bind:path={remote}
    showHidden={app.settings.sftpShowHidden}
    disabled={!connected}
    sendLabel="Download"
    list={(p) => api.sftp.list(sid, p)}
    onsend={(entries: FileEntry[]) => void download(entries)}
    onreceive={(paths) => upload(paths)}
    onmkdir={(p) => api.sftp.mkdir(sid, p)}
    onrename={(from, to) => api.sftp.rename(sid, from, to)}
    onremove={(entries) => api.sftp.remove(sid, entries.map((e) => e.path))}
    onedit={(e) =>
      app.settings.editorCommand ? api.sftp.edit(sid, e.path).catch((err) => app.fail(err)) : app.openEditor(tab, e.path, sid)}
    onterminal={oncd}
    terminalLabel="cd here in the terminal"
    {tools}
    overlay={connected ? undefined : connectionState}
  />
  {#if connected && follow && !tab.cwd}
    <p class="hint muted">
      This shell does not report its folder, so the files stay put when you cd.
      <button type="button" class="link" onclick={() => api.app.openExternal(FOLLOW_HELP)}>Turn it on</button>
    </p>
  {/if}
  <Edits sessionId={sid} />
  <Transfers sessionId={sid} />
</aside>

<style>
  .files {
    position: relative;
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 8px;
    min-width: 240px;
    max-width: 50%;
    padding: 8px 8px 8px 10px;
    border-left: 1px solid var(--border-weak);
    background: var(--bg);
  }
  .files > :global(.pane) {
    flex: 1;
  }
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    z-index: 5;
    width: 6px;
    cursor: col-resize;
  }
  .grip:hover,
  .grip:focus-visible {
    background: var(--border);
    outline: none;
  }
  .on {
    color: var(--text-strong);
    background: var(--bg-selected);
  }
  .panel {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    max-width: 90%;
    padding: 14px 16px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius-lg);
    background: var(--bg);
  }
  .panel p {
    display: flex;
    align-items: center;
    gap: 8px;
    line-height: 1.5;
  }
  .hint {
    font-size: 12px;
    line-height: 1.5;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-strong);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
