<script lang="ts">
  import X from '@lucide/svelte/icons/x'
  import RadioTower from '@lucide/svelte/icons/radio-tower'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import { app, isTerminal, tabName, type Split, type Tab } from '$lib/state.svelte'
  import { layout, leaves, type Divider, type Rect } from '$lib/panes'
  import { tabMenu } from '$lib/tab-menu.svelte'
  import { tint } from '$lib/folders'
  import { shellSafeLabel } from '$lib/keys'
  import TitleBar from './TitleBar.svelte'
  import VaultView from './VaultView.svelte'
  import TerminalView from './TerminalView.svelte'
  import SftpView from './SftpView.svelte'
  import DockerView from './DockerView.svelte'
  const loadEditor = () => import('./FileEditor.svelte')
  import Palette from './Palette.svelte'

  let main = $state<HTMLElement>()

  const split = $derived(app.splitOf(app.active))
  const panes = $derived(split ? layout(split.root) : null)
  const terminals = $derived(
    split ? app.tabs.filter((t) => isTerminal(t) && leaves(split.root).includes(t.id)).length : 0
  )

  const percent = (n: number): string => `${n * 100}%`
  const inset = (r: Rect): string => `${percent(r.y)} ${percent(1 - r.x - r.w)} ${percent(1 - r.y - r.h)} ${percent(r.x)}`

  function focus(tab: Tab): void {
    if (app.active !== tab.id) app.active = tab.id
  }

  // each side keeps at least 80px, so a pane never shrinks below a usable terminal
  function limit(d: Divider<string>, ratio: number): number {
    const box = main?.getBoundingClientRect()
    const size = box ? (d.node.dir === 'row' ? d.area.w * box.width : d.area.h * box.height) : 0
    const edge = size ? Math.min(0.45, Math.max(0.05, 80 / size)) : 0.05
    return Math.min(1 - edge, Math.max(edge, ratio))
  }

  function drag(e: PointerEvent, d: Divider<string>): void {
    if (e.button !== 0 || !main) return
    e.preventDefault()
    const handle = e.currentTarget as HTMLElement
    const box = main.getBoundingClientRect()
    const row = d.node.dir === 'row'
    const start = row ? box.left + d.area.x * box.width : box.top + d.area.y * box.height
    const size = row ? d.area.w * box.width : d.area.h * box.height
    const move = (ev: PointerEvent): void => {
      d.node.ratio = limit(d, ((row ? ev.clientX : ev.clientY) - start) / size)
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('lostpointercapture', end)
      app.persistTabs()
    }
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('lostpointercapture', end)
  }

  function nudge(e: KeyboardEvent, d: Divider<string>): void {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
    if (!step) return
    e.preventDefault()
    d.node.ratio = limit(d, d.node.ratio + step * 0.02)
    app.persistTabs()
  }
</script>

{#snippet header(tab: Tab, split: Split)}
  <div
    class={['head', tab.color && 'colored']}
    style:--tab-color={tint(tab.color)}
    role="presentation"
    ondblclick={() => app.renameTab(tab.id)}
    oncontextmenu={(e) => app.openMenu(e, tabMenu(tab, 'pane'))}
  >
    <span class="kind">{tab.kind}</span>
    {#if tab.status !== 'connected'}<span class={['dot', tab.status]} title={tab.status}></span>{/if}
    <span class="name" title={tab.message}>{tabName(tab)}</span>
    {#if tab.bell}<span class="bell" title="bell">!</span>{/if}
    {#if isTerminal(tab) && terminals > 1}
      <button
        type="button"
        class={['head-btn', split.broadcast && 'cast']}
        aria-pressed={split.broadcast}
        title={split.broadcast ? 'Stop broadcasting input' : 'Broadcast input to all panes'}
        onclick={() => app.toggleBroadcast(split)}
        ><RadioTower size={13} />{#if split.broadcast}<span>broadcast</span>{/if}</button
      >
    {/if}
    {#if tab.kind === 'ssh'}
      <button
        type="button"
        class={['head-btn', tab.files && 'on']}
        aria-pressed={!!tab.files}
        title="{tab.files ? 'Hide' : 'Show'} files ({shellSafeLabel('B')})"
        onclick={() => app.toggleFiles(tab.id)}><FolderOpen size={13} /></button
      >
    {/if}
    <button type="button" class="head-btn" aria-label="Close pane" title="Close pane" onclick={() => app.closeTab(tab.id)}
      ><X size={13} /></button
    >
  </div>
{/snippet}

<div class="shell" inert={app.status?.state !== 'unlocked'}>
  <TitleBar />
  <main bind:this={main}>
    <div class="view" hidden={app.active !== 'home'}>
      {#if app.vault}
        <VaultView />
      {/if}
    </div>
    {#each app.tabs as tab (tab.id)}
      {@const rect = panes?.panes.get(tab.id)}
      <div
        class={['view', rect && 'pane', rect && app.active === tab.id && 'focused']}
        hidden={!rect && app.active !== tab.id}
        style:inset={rect && inset(rect)}
        onpointerdowncapture={() => rect && focus(tab)}
        onfocusin={() => rect && focus(tab)}
      >
        {#if rect && split}
          {@render header(tab, split)}
        {/if}
        <div class="body">
          {#if isTerminal(tab)}
            <TerminalView {tab} active={app.active === tab.id} />
          {:else if tab.kind === 'sftp'}
            <SftpView {tab} />
          {:else if tab.kind === 'edit'}
            {#await loadEditor() then { default: FileEditor }}
              <FileEditor {tab} active={app.active === tab.id} />
            {/await}
          {:else}
            <DockerView {tab} active={app.active === tab.id || !!rect} />
          {/if}
        </div>
      </div>
    {/each}
    {#each panes?.dividers ?? [] as d, i (i)}
      {@const row = d.node.dir === 'row'}
      {@const at = row ? d.area.x + d.area.w * d.node.ratio : d.area.y + d.area.h * d.node.ratio}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class={['divider', d.node.dir]}
        role="separator"
        tabindex="0"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(d.node.ratio * 100)}
        aria-label="Resize panes"
        style:left={percent(row ? at : d.area.x)}
        style:top={percent(row ? d.area.y : at)}
        style:width={row ? undefined : percent(d.area.w)}
        style:height={row ? percent(d.area.h) : undefined}
        onpointerdown={(e) => drag(e, d)}
        onkeydown={(e) => nudge(e, d)}
      ></div>
    {/each}
  </main>
  {#if app.paletteOpen && app.vault}
    <Palette />
  {/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  main {
    --pane-head: 26px;
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .view {
    position: absolute;
    inset: 0;
  }
  .body {
    position: absolute;
    inset: 0;
  }
  .pane .body {
    top: var(--pane-head);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--pane-head);
    padding: 0 4px 0 10px;
    border-bottom: 1px solid var(--border-weak);
    background: var(--bg-weak);
    color: var(--text-weak);
    font-size: 12px;
    white-space: nowrap;
  }
  .focused .head {
    background: var(--bg-selected);
    color: var(--text-strong);
  }
  .kind {
    flex: none;
    padding: 0 5px;
    border: 1px solid var(--border-weak);
    border-radius: 3px;
    font-size: 10px;
    line-height: 14px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .colored .kind {
    border-color: var(--tab-color);
    color: var(--tab-color);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bell {
    color: var(--warning);
    font-weight: 600;
  }
  .head-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 4px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--text-weak);
    font: inherit;
    cursor: pointer;
  }
  .head-btn:hover {
    background: var(--bg-weak-hover);
    color: var(--text-strong);
  }
  .head-btn.cast {
    color: var(--warning);
  }
  .head-btn.on {
    color: var(--text-strong);
  }
  .divider {
    position: absolute;
    z-index: 20;
    outline: none;
  }
  .divider.row {
    width: 7px;
    margin-left: -3px;
    cursor: col-resize;
  }
  .divider.column {
    height: 7px;
    margin-top: -3px;
    cursor: row-resize;
  }
  .divider::before {
    content: '';
    position: absolute;
    background: var(--border-weak);
  }
  .divider.row::before {
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
  }
  .divider.column::before {
    top: 3px;
    right: 0;
    left: 0;
    height: 1px;
  }
  .divider:hover::before,
  .divider:active::before,
  .divider:focus-visible::before {
    background: var(--focus);
  }
</style>
