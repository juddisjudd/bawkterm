<script lang="ts">
  import { onMount } from 'svelte'
  import { app } from '$lib/state.svelte'
  import { mod, shellSafe } from '$lib/keys'
  import LockScreen from '$lib/components/LockScreen.svelte'
  import Shell from '$lib/components/Shell.svelte'
  import Modals from '$lib/components/Modals.svelte'
  import Toasts from '$lib/components/Toasts.svelte'
  import ContextMenu from '$lib/components/ContextMenu.svelte'
  import WindowControls from '$lib/components/WindowControls.svelte'

  let lastActivity = Date.now()

  onMount(() => {
    void app.init()
    const timer = setInterval(() => {
      const minutes = app.settings.autoLockMinutes
      if (minutes > 0 && app.vault && Date.now() - lastActivity > minutes * 60_000) void app.lock()
    }, 15_000)
    return () => clearInterval(timer)
  })

  $effect(() => {
    const root = document.documentElement
    root.dataset.theme = app.theme
    const colors = app.appColors
    if (!colors) return
    for (const [name, value] of Object.entries(colors)) root.style.setProperty(name, value)
    return () => Object.keys(colors).forEach((name) => root.style.removeProperty(name))
  })

  function onkeydown(e: KeyboardEvent): void {
    lastActivity = Date.now()
    if (!app.vault) return
    const key = e.key.toLowerCase()
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      app.cycleTab(e.shiftKey ? -1 : 1)
    } else if (mod(e) && e.shiftKey && (key === 'p' || key === 's')) {
      e.preventDefault()
      e.stopPropagation()
      if (app.paletteOpen) app.paletteOpen = false
      else app.openPalette(key === 's' ? 'snippets' : 'all')
    } else if (shellSafe(e, 'w')) {
      e.preventDefault()
      e.stopPropagation()
      if (app.active !== 'home') app.closeTab(app.active)
    } else if (mod(e) && e.shiftKey && key === 'l') {
      e.preventDefault()
      e.stopPropagation()
      void app.lock()
    }
  }
</script>

<svelte:window onkeydowncapture={onkeydown} onpointerdown={() => (lastActivity = Date.now())} />

{#if app.status}
  {#if app.everUnlocked}
    <Shell />
  {/if}
  {#if app.status.state !== 'unlocked'}
    <LockScreen />
  {/if}
{/if}

{#if window.api.platform !== 'darwin'}
  <WindowControls />
{/if}

<Modals />
<ContextMenu />
<Toasts />
