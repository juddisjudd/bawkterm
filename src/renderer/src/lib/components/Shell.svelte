<script lang="ts">
  import { app } from '$lib/state.svelte'
  import TitleBar from './TitleBar.svelte'
  import VaultView from './VaultView.svelte'
  import TerminalView from './TerminalView.svelte'
  import SftpView from './SftpView.svelte'
  import DockerView from './DockerView.svelte'
  const loadEditor = () => import('./FileEditor.svelte')
  import Palette from './Palette.svelte'
</script>

<div class="shell" inert={app.status?.state !== 'unlocked'}>
  <TitleBar />
  <main>
    <div class="view" hidden={app.active !== 'home'}>
      {#if app.vault}
        <VaultView />
      {/if}
    </div>
    {#each app.tabs as tab (tab.id)}
      <div class="view" hidden={app.active !== tab.id}>
        {#if tab.kind === 'ssh'}
          <TerminalView {tab} active={app.active === tab.id} />
        {:else if tab.kind === 'sftp'}
          <SftpView {tab} />
        {:else if tab.kind === 'edit'}
          {#await loadEditor() then { default: FileEditor }}
            <FileEditor {tab} active={app.active === tab.id} />
          {/await}
        {:else}
          <DockerView {tab} active={app.active === tab.id} />
        {/if}
      </div>
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
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .view {
    position: absolute;
    inset: 0;
  }
</style>
