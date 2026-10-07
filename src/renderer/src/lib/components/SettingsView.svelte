<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { CursorStyle, EditorChoice, Settings, TerminalLook, ThemeSetting } from '@shared/types'
  import { DEFAULT_APP_EDITOR } from '@shared/defaults'
  import { app, type SettingsTab } from '$lib/state.svelte'
  import PageHeader from './PageHeader.svelte'
  import Checkbox from './Checkbox.svelte'
  import SyncSettings from './SyncSettings.svelte'
  import { TERMINAL_THEMES, builtinThemeNamed, terminalTheme, themeFromPalette } from '$lib/theme'
  import { enrollPasskey } from '$lib/passkey'
  import Palette from '@lucide/svelte/icons/palette'
  import SquareTerminal from '@lucide/svelte/icons/square-terminal'
  import Cable from '@lucide/svelte/icons/cable'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import Cloud from '@lucide/svelte/icons/cloud'
  import Lock from '@lucide/svelte/icons/lock'
  import CircleArrowDown from '@lucide/svelte/icons/circle-arrow-down'
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import { MOD, SPLIT_KEYS, isMac, shellSafeLabel } from '$lib/keys'
  import { exportBackup, importFromFile, openExportMenu, openImportMenu } from '$lib/transfer'

  const s = $derived(app.settings)
  const windows = window.api.platform === 'win32'
  const keyring = windows ? 'Windows DPAPI' : isMac ? 'the macOS Keychain' : 'the system keyring'
  const modKey = MOD.toLowerCase()
  const shellKey = (key: string): string => shellSafeLabel(key).toLowerCase()

  const tabs = [
    { id: 'appearance', label: 'appearance', icon: Palette },
    { id: 'terminal', label: 'terminal', icon: SquareTerminal },
    { id: 'connections', label: 'connections', icon: Cable },
    { id: 'files', label: 'files', icon: FolderOpen },
    { id: 'sync', label: 'sync', icon: Cloud },
    { id: 'security', label: 'security', icon: Lock },
    { id: 'updates', label: 'updates', icon: CircleArrowDown },
    { id: 'shortcuts', label: 'shortcuts', icon: Keyboard }
  ] satisfies { id: SettingsTab; label: string; icon: unknown }[]
  const current = $derived(tabs.find((t) => t.id === app.settingsTab) ?? tabs[0])

  async function tabKey(e: KeyboardEvent): Promise<void> {
    const i = tabs.findIndex((t) => t.id === current.id)
    let next: number
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        next = (i + 1) % tabs.length
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        next = (i - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    app.settingsTab = tabs[next].id
    await tick()
    document.getElementById(`settings-tab-${tabs[next].id}`)?.focus()
  }

  async function set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    await window.api.settings.save({ ...app.settings, [key]: value }).catch((err) => app.fail(err))
  }

  function num(e: Event, min: number, max: number): number | null {
    const n = Number((e.currentTarget as HTMLInputElement).value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
  }

  const themeList = $derived([...TERMINAL_THEMES, ...s.customThemes])
  const importedActive = $derived(s.customThemes.find((t) => t.id === s.terminalTheme))
  let looks = $state<TerminalLook[] | null>(null)
  let finding = $state(false)

  async function findLooks(): Promise<void> {
    finding = true
    looks = await window.api.app.terminalLooks().catch((err) => {
      app.fail(err)
      return null
    })
    finding = false
  }

  function lookSummary(look: TerminalLook): string {
    const known = !look.palette && look.scheme ? builtinThemeNamed(look.scheme) : undefined
    const colors = look.palette ? 'colors' : known ? `${known.label} theme` : look.scheme ? `"${look.scheme}" colors not found` : 'no colors set'
    const font = look.fonts && `${look.fonts[0]}${look.fontSize ? ` ${look.fontSize}px` : ''}`
    return [colors, font, look.cursorStyle && `${look.cursorStyle} cursor`].filter(Boolean).join(' · ')
  }

  const sentence = (words: string[]): string => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0])

  async function importLook(look: TerminalLook): Promise<void> {
    const next: Settings = { ...app.settings }
    const got: string[] = []
    const known = look.scheme ? builtinThemeNamed(look.scheme) : undefined
    if (look.palette) {
      const theme = themeFromPalette(look.terminal, look.name, look.palette)
      next.customThemes = [...next.customThemes.filter((t) => t.id !== theme.id), theme].slice(-50)
      next.terminalTheme = theme.id
      got.push('colors')
    } else if (known) {
      next.terminalTheme = known.id
      got.push(`the ${known.label} theme`)
    }
    if (look.fonts) {
      next.terminalFontFamily = [...look.fonts.map((f) => `"${f.replace(/"/g, '')}"`), '"IBM Plex Mono"', 'monospace'].join(', ')
      got.push('font')
    }
    if (look.fontSize) next.terminalFontSize = Math.min(32, Math.max(8, look.fontSize))
    if (look.cursorStyle) {
      next.cursorStyle = look.cursorStyle
      got.push('cursor')
    }
    if (look.cursorBlink !== undefined) next.cursorBlink = look.cursorBlink
    if (!got.length) {
      app.toast(`${look.terminal} has no colors, font or cursor set`, 'error')
      return
    }
    await window.api.settings.save(next).then(
      () => app.toast(`Imported ${sentence(got)} from ${look.terminal}`),
      (err) => app.fail(err)
    )
  }

  async function removeImported(id: string): Promise<void> {
    const next = { ...app.settings, customThemes: app.settings.customThemes.filter((t) => t.id !== id) }
    if (next.terminalTheme === id) next.terminalTheme = 'auto'
    await window.api.settings.save(next).catch((err) => app.fail(err))
  }

  let editors = $state<EditorChoice[]>([])
  let customEditor = $state(false)
  const editorChoice = $derived(
    customEditor ||
      (s.editorCommand !== '' && s.editorCommand !== DEFAULT_APP_EDITOR && !editors.some((e) => e.command === s.editorCommand))
      ? 'custom'
      : s.editorCommand
  )

  onMount(() => {
    window.api.app.editors().then((list) => (editors = list), () => {})
  })

  let logFolder = $state('')
  $effect(() => {
    void s.sessionLogFolder
    window.api.local.logFolder().then((folder) => (logFolder = folder), () => {})
  })

  async function chooseLogFolder(): Promise<void> {
    const folder = await window.api.local.chooseLogFolder().catch((err) => app.fail(err))
    if (folder) await set('sessionLogFolder', folder)
  }

  async function browseEditor(): Promise<void> {
    const command = await window.api.app.pickEditor().catch((err) => app.fail(err))
    if (command) await set('editorCommand', command)
  }

  function chooseEditor(value: string): void {
    customEditor = value === 'custom'
    if (customEditor) void browseEditor()
    else void set('editorCommand', value)
  }

  const update = $derived(app.updateStatus)
  let checking = $state(false)
  const updateLine = $derived.by(() => {
    switch (update.state) {
      case 'checking':
        return 'checking for updates…'
      case 'downloading':
        return `downloading v${update.version}… ${update.percent ?? 0}%`
      case 'ready':
        return `v${update.version} is ready to install`
      case 'none':
        return `you have v${__APP_VERSION__}, the latest version`
      case 'error':
        return 'could not check for updates'
      default:
        return `you have v${__APP_VERSION__}`
    }
  })
  const managedHint = $derived(
    update.managedBy === 'dev'
      ? 'Development builds do not update themselves.'
      : update.managedBy === 'flatpak'
        ? 'This Flatpak is updated with "flatpak update".'
        : update.managedBy === 'manual'
          ? 'The macOS app cannot update itself yet. Download new versions from the GitHub releases page.'
          : 'This install is updated by your package manager.'
  )

  async function checkForUpdates(): Promise<void> {
    checking = true
    try {
      await window.api.update.check()
    } catch (err) {
      app.fail(err)
    } finally {
      checking = false
    }
  }

  const methods = $derived(app.unlockStatus)
  let working = $state<'hello' | 'passkey' | null>(null)

  async function toggleMethod(kind: 'hello' | 'passkey', on: boolean): Promise<void> {
    const password = on
      ? await app.askMasterPassword('A new unlock method opens this vault without the password from now on.')
      : ''
    if (on && !password) return
    working = kind
    try {
      if (on) await window.api.vault.verifyPassword(password!)
      if (kind === 'hello') {
        await (on ? window.api.unlock.enableHello(password!) : window.api.unlock.disableHello())
      } else if (on) {
        const { enrollment, output } = await enrollPasskey()
        await window.api.unlock.enablePasskey(enrollment, output, password!)
      } else {
        await window.api.unlock.disablePasskey()
      }
      await app.refreshUnlock()
      const name = kind === 'hello' ? 'Windows Hello' : 'Passkey'
      app.toast(on ? `${name} unlock is on` : `${name} unlock is off${kind === 'passkey' ? '. The passkey stays on your device until you delete it there.' : ''}`)
    } catch (err) {
      app.fail(err)
    } finally {
      working = null
    }
  }

  let rememberKey = $state(0)

  async function setRemember(on: boolean): Promise<void> {
    const password = on
      ? await app.askMasterPassword(`Anyone signed in to this ${windows ? 'Windows ' : ''}account will be able to open the vault without the password.`)
      : undefined
    if (on && !password) {
      rememberKey++
      return
    }
    try {
      app.status = await window.api.vault.setRemember(on, password ?? undefined)
    } catch (err) {
      rememberKey++
      app.fail(err)
    }
  }

  async function changePassword(): Promise<void> {
    const res = await app.ask({
      title: 'Change master password',
      message:
        'The vault gets a new encryption key, so older copies and backups of it no longer open. Windows Hello and passkey unlock are turned off; set them up again afterwards.',
      fields: [
        { name: 'current', label: 'current password', secret: true },
        { name: 'next', label: 'new password', secret: true },
        { name: 'confirm', label: 'confirm new password', secret: true }
      ],
      confirmLabel: 'Change password'
    })
    if (!res) return
    if (res.values.next !== res.values.confirm) {
      app.toast('The new passwords do not match', 'error')
      return
    }
    try {
      await window.api.vault.changePassword(res.values.current, res.values.next)
      await app.refreshUnlock()
      app.toast('Master password changed')
    } catch (err) {
      app.fail(err)
    }
  }

  const themes: { id: ThemeSetting; label: string }[] = [
    { id: 'system', label: 'system' },
    { id: 'dark', label: 'dark' },
    { id: 'light', label: 'light' },
    { id: 'terminal', label: 'match terminal' }
  ]
  const cursors: CursorStyle[] = ['block', 'bar', 'underline']
</script>

<div class="page">
  <PageHeader title="settings" subtitle="Saved in the encrypted vault on this device." />

  <div class="layout">
    <div class="tabs" role="tablist" aria-orientation="vertical" aria-label="settings">
      {#each tabs as t (t.id)}
        <button
          type="button"
          role="tab"
          id="settings-tab-{t.id}"
          aria-selected={current.id === t.id}
          aria-controls="settings-panel"
          tabindex={current.id === t.id ? 0 : -1}
          class={['tab', current.id === t.id && 'active']}
          onclick={() => (app.settingsTab = t.id)}
          onkeydown={tabKey}
        >
          <t.icon size={15} />
          <span>{t.label}</span>
        </button>
      {/each}
    </div>

    <div class="panel" role="tabpanel" id="settings-panel" aria-labelledby="settings-tab-{current.id}">
      <h2>{current.label}</h2>

      {#if current.id === 'appearance'}
        <div class="row">
          <span>app theme</span>
          <div class="seg">
            {#each themes as t (t.id)}
              <button type="button" class:active={s.theme === t.id} onclick={() => set('theme', t.id)}>{t.label}</button>
            {/each}
          </div>
        </div>
        <h3>terminal theme</h3>
        <div class="themes" role="radiogroup" aria-label="terminal theme">
          {#each themeList as t (t.id)}
            {@const colors = terminalTheme(t.id, app.theme)}
            {@const words = t.label.split(' ')}
            <button
              type="button"
              role="radio"
              aria-checked={s.terminalTheme === t.id}
              class={['theme', s.terminalTheme === t.id && 'active']}
              style:background={colors.background}
              style:color={colors.foreground}
              onclick={() => set('terminalTheme', t.id)}
            >
              <span class="theme-name">{words.slice(0, -1).join(' ')} <span class="last">{words.at(-1)}<span class="caret" style:background={colors.cursor}></span></span></span>
              <span class="swatches">
                {#each [colors.red, colors.green, colors.yellow, colors.blue, colors.magenta, colors.cyan] as c, i (i)}
                  <span style:background={c}></span>
                {/each}
              </span>
            </button>
          {/each}
        </div>
        {#if importedActive}
          <div class="row">
            <span class="hint">Imported from your terminal.</span>
            <button type="button" class="btn small" onclick={() => removeImported(importedActive.id)}>Remove this theme</button>
          </div>
        {/if}
        <h3>terminal text</h3>
        <label class="row">
          <span>font</span>
          <input class="input wide" value={s.terminalFontFamily} spellcheck="false"
            onchange={(e) => set('terminalFontFamily', e.currentTarget.value || '"IBM Plex Mono", monospace')} />
        </label>
        <label class="row">
          <span>font size</span>
          <input class="input narrow" type="number" min="8" max="32" value={s.terminalFontSize}
            onchange={(e) => { const n = num(e, 8, 32); if (n) set('terminalFontSize', n) }} />
        </label>
        <label class="row">
          <span>line height</span>
          <input class="input narrow" type="number" min="1" max="2" step="0.05" value={s.terminalLineHeight}
            onchange={(e) => { const n = num(e, 1, 2); if (n) set('terminalLineHeight', n) }} />
        </label>
        <div class="row">
          <span>cursor</span>
          <div class="seg">
            {#each cursors as c (c)}
              <button type="button" class:active={s.cursorStyle === c} onclick={() => set('cursorStyle', c)}>{c}</button>
            {/each}
          </div>
        </div>
        <div class="checks">
          <Checkbox checked={s.cursorBlink} label="blinking cursor" onchange={(v) => set('cursorBlink', v)} />
        </div>
        <h3>from your terminal</h3>
        <p class="hint">Copy the colors, font and cursor from a terminal on this computer.</p>
        {#if looks === null}
          <div class="row">
            <button type="button" class="btn" disabled={finding} onclick={findLooks}>{finding ? 'Looking…' : 'Find installed terminals'}</button>
          </div>
        {:else if looks.length}
          <ul class="looks">
            {#each looks as look, i (i)}
              <li class="look">
                <span class="swatches">
                  {#each look.palette?.ansi.slice(1, 7) ?? [] as c, j (j)}<span style:background={c}></span>{/each}
                </span>
                <span class="stack">
                  <span>{look.terminal}{look.name !== look.terminal ? ` · ${look.name}` : ''}</span>
                  <span class="hint">{lookSummary(look)}</span>
                </span>
                <button type="button" class="btn small" onclick={() => importLook(look)}>Import</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="hint note">No settings found for Windows Terminal, Alacritty, Ghostty, Kitty, WezTerm, iTerm2 or Warp.</p>
        {/if}

      {:else if current.id === 'terminal'}
        <label class="row">
          <span>local shell ({shellKey('t')})</span>
          <select class="select wide" value={s.localShell} onchange={(e) => set('localShell', e.currentTarget.value)}>
            <option value="">{app.shells[0] ? `first found (${app.shells[0].name})` : 'first found'}</option>
            {#each app.shells as shell (shell.id)}
              <option value={shell.id}>{shell.name}</option>
            {/each}
          </select>
        </label>
        <label class="row">
          <span>scrollback lines</span>
          <input class="input narrow" type="number" min="500" max="200000" step="500" value={s.scrollback}
            onchange={(e) => { const n = num(e, 500, 200000); if (n) set('scrollback', n) }} />
        </label>
        <h3>clipboard</h3>
        <div class="checks">
          <Checkbox checked={s.copyOnSelect} label="copy text when selected" onchange={(v) => set('copyOnSelect', v)} />
          <Checkbox checked={s.rightClickPaste} label="right click copies the selection or pastes" onchange={(v) => set('rightClickPaste', v)} />
          <Checkbox checked={s.pasteProtection} label="ask before pasting several lines into a shell" onchange={(v) => set('pasteProtection', v)} />
          <Checkbox checked={s.osc52} label="let remote programs (tmux, vim) copy to my clipboard" onchange={(v) => set('osc52', v)} />
        </div>
        <h3>notifications</h3>
        <div class="checks">
          <Checkbox checked={s.bellNotify} label="notify when a background tab rings the bell" onchange={(v) => set('bellNotify', v)} />
        </div>
        <h3>session logs</h3>
        <div class="checks">
          <Checkbox checked={s.sessionLogs} label="save what each terminal shows to a text file" onchange={(v) => set('sessionLogs', v)} />
        </div>
        {#if s.sessionLogs}
          <div class="row">
            <span class="selectable">{logFolder}</span>
            <span class="buttons">
              <button type="button" class="btn" onclick={chooseLogFolder}>Change…</button>
              <button type="button" class="btn" onclick={() => window.api.local.openLogFolder().catch((err) => app.fail(err))}>Open</button>
            </span>
          </div>
          <p class="hint">One file per connection, starting with the next one. Logs are plain text outside the vault, so anything a server prints ends up in them.</p>
        {/if}

      {:else if current.id === 'connections'}
        <label class="row">
          <span>keepalive interval (seconds, 0 = off)</span>
          <input class="input narrow" type="number" min="0" max="600" value={s.keepAliveSec}
            onchange={(e) => { const n = num(e, 0, 600); if (n !== null) set('keepAliveSec', n) }} />
        </label>
        <div class="checks">
          <Checkbox checked={s.autoReconnect} label="reconnect automatically when a connection drops" onchange={(v) => set('autoReconnect', v)} />
          <Checkbox checked={s.restoreTabs} label="reopen my tabs when bawkterm starts" onchange={(v) => set('restoreTabs', v)} />
          <Checkbox checked={s.checkHosts} label="show which hosts answer (checks their port each minute while the host list is open)" onchange={(v) => set('checkHosts', v)} />
        </div>
        <h3>import and export</h3>
        <div class="row">
          <span>hosts from ~/.ssh/config, PuTTY, WinSCP, FileZilla, MobaXterm or a CSV file</span>
          <button type="button" class="btn" aria-haspopup="menu" onclick={(e) => openImportMenu(e.currentTarget)}>Import</button>
        </div>
        <div class="row">
          <span>hosts as an SSH config or CSV file, without passwords or keys</span>
          <button type="button" class="btn" aria-haspopup="menu" onclick={(e) => openExportMenu(e.currentTarget)}>Export</button>
        </div>

      {:else if current.id === 'files'}
        <label class="row">
          <span>open remote files with</span>
          <select class="select wide" value={editorChoice} onchange={(e) => chooseEditor(e.currentTarget.value)}>
            <option value="">built-in editor</option>
            {#each editors as editor (editor.command)}
              <option value={editor.command}>{editor.name}</option>
            {/each}
            <option value={DEFAULT_APP_EDITOR}>{windows ? 'Windows' : 'system'} default app</option>
            <option value="custom">other program…</option>
          </select>
        </label>
        {#if editorChoice === 'custom'}
          <div class="row">
            <input class="input" value={s.editorCommand} placeholder={windows ? '"C:\\Program Files\\Editor\\editor.exe"' : isMac ? '"/Applications/Editor.app"' : '/usr/bin/editor'} spellcheck="false"
              aria-label="editor command" onchange={(e) => set('editorCommand', e.currentTarget.value.trim())} />
            <button type="button" class="btn" onclick={browseEditor}>Browse…</button>
          </div>
        {/if}
        <div class="checks">
          <Checkbox checked={s.sftpShowHidden} label="show hidden files in SFTP" onchange={(v) => set('sftpShowHidden', v)} />
        </div>

      {:else if current.id === 'sync'}
        <SyncSettings />

      {:else if current.id === 'security'}
        <h3>locking</h3>
        <label class="row">
          <span>idle minutes before locking (0 = never)</span>
          <input class="input narrow" type="number" min="0" max="1440" value={s.autoLockMinutes}
            onchange={(e) => { const n = num(e, 0, 1440); if (n !== null) set('autoLockMinutes', n) }} />
        </label>
        <div class="checks">
          <Checkbox checked={s.lockOnSystemLock} label={windows ? 'lock when Windows locks or goes to sleep' : isMac ? 'lock when the Mac locks or goes to sleep' : 'lock when the computer goes to sleep'} onchange={(v) => set('lockOnSystemLock', v)} />
        </div>

        <h3>unlocking</h3>
        <div class="row">
          <span>master password</span>
          <button type="button" class="btn" onclick={changePassword}>Change…</button>
        </div>
        {#if app.status?.canRemember}
          <div class="checks">
            {#key rememberKey}
              <Checkbox checked={app.status.remembered} label="unlock automatically on this device (uses {keyring})" onchange={setRemember} />
            {/key}
            {#if app.status.remembered}
              <span class="hint indent">Anyone signed in to this {windows ? 'Windows ' : ''}account can open the vault without the password.</span>
            {/if}
          </div>
        {/if}
        {#if windows}
          <div class="row">
            <span class="stack">
              <span>Windows Hello (PIN, fingerprint or face)</span>
              {#if !methods}
                <span class="hint">checking…</span>
              {:else if !methods.hello.supported && !methods.hello.enabled}
                <span class="hint">Set up Windows Hello first: Settings → Accounts → Sign-in options</span>
              {/if}
            </span>
            {#if methods?.hello.enabled}
              <button type="button" class="btn ghost danger" disabled={!!working} onclick={() => toggleMethod('hello', false)}>Turn off</button>
            {:else}
              <button type="button" class="btn" disabled={!!working || !methods?.hello.supported} onclick={() => toggleMethod('hello', true)}>
                {working === 'hello' ? 'waiting…' : 'Turn on'}
              </button>
            {/if}
          </div>
          <div class="row">
            <span class="stack">
              <span>passkey</span>
              <span class="hint">Your phone (scan a QR code, Bluetooth on), a security key, or this PC</span>
            </span>
            {#if methods?.passkey.enabled}
              <button type="button" class="btn ghost danger" disabled={!!working} onclick={() => toggleMethod('passkey', false)}>Turn off</button>
            {:else}
              <button type="button" class="btn" disabled={!!working} onclick={() => toggleMethod('passkey', true)}>
                {working === 'passkey' ? 'waiting…' : 'Set up…'}
              </button>
            {/if}
          </div>
          <p class="hint note">Your master password always works too. These only add faster ways to unlock.</p>
        {/if}

        <h3>backup</h3>
        <div class="row">
          <span class="stack">
            <span>encrypted backup file</span>
            <span class="hint">Hosts, passwords, keys, identities, snippets and trusted host keys, encrypted with your master password</span>
          </span>
          <button type="button" class="btn" onclick={exportBackup}>Save backup…</button>
        </div>
        <div class="row">
          <span class="stack">
            <span>restore from a backup</span>
            <span class="hint">Adds what this vault is missing and never deletes anything</span>
          </span>
          <button type="button" class="btn" onclick={importFromFile}>Restore…</button>
        </div>

      {:else if current.id === 'updates'}
        {#if update.supported}
          <div class="row">
            <span class="stack">
              <span>{updateLine}</span>
              {#if update.state === 'error' && update.error}<span class="hint selectable">{update.error}</span>{/if}
            </span>
            {#if update.state === 'ready'}
              <button type="button" class="btn strong" onclick={() => app.restartToUpdate()}>Restart and update</button>
            {:else}
              <button
                type="button"
                class="btn"
                disabled={checking || update.state === 'checking' || update.state === 'downloading'}
                onclick={checkForUpdates}>Check now</button
              >
            {/if}
          </div>
          <div class="checks">
            <Checkbox checked={s.autoUpdate} label="check for updates automatically" onchange={(v) => set('autoUpdate', v)} />
          </div>
        {:else}
          <p>bawkterm v{__APP_VERSION__}</p>
          <p class="hint note">{managedHint}</p>
        {/if}

      {:else if current.id === 'shortcuts'}
        <dl>
          <dt><span class="kbd">{modKey}+shift+p</span></dt><dd>open host / quick connect</dd>
          <dt><span class="kbd">{modKey}+shift+s</span></dt><dd>run a snippet in the terminal</dd>
          <dt><span class="kbd">{shellKey('f')}</span></dt><dd>search terminal output</dd>
          <dt><span class="kbd">{modKey}+= / - / 0</span></dt><dd>zoom terminal text in, out, reset</dd>
          <dt><span class="kbd">ctrl+tab</span></dt><dd>next tab</dd>
          <dt><span class="kbd">{shellKey('w')}</span></dt><dd>close tab or pane</dd>
          <dt><span class="kbd">{shellKey('t')}</span></dt><dd>new local terminal</dd>
          <dt><span class="kbd">{shellKey('b')}</span></dt><dd>show or hide files beside an SSH terminal</dd>
          <dt><span class="kbd">{SPLIT_KEYS.row.toLowerCase()}</span></dt><dd>split right</dd>
          <dt><span class="kbd">{SPLIT_KEYS.column.toLowerCase()}</span></dt><dd>split down</dd>
          <dt><span class="kbd">{modKey}+{isMac ? 'option' : 'alt'}+arrows</span></dt><dd>move between panes</dd>
          <dt><span class="kbd">{shellKey('c')} / v</span></dt><dd>copy / paste in terminal</dd>
          <dt><span class="kbd">{modKey}+shift+l</span></dt><dd>lock vault</dd>
          <dt><span class="kbd">{modKey}+click</span></dt><dd>open a link in the terminal</dd>
        </dl>
      {/if}
    </div>
  </div>
</div>

<style>
  .page {
    container-type: inline-size;
    padding: 32px 40px 64px;
  }
  .layout {
    display: grid;
    grid-template-columns: 168px minmax(0, 640px);
    gap: 40px;
    align-items: start;
  }
  .tabs {
    position: sticky;
    top: 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-weak);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--text-strong);
    background: var(--bg-weak);
  }
  .tab.active {
    background: var(--bg-weak-hover);
    color: var(--text-strong);
  }
  @container (max-width: 560px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      gap: 20px;
    }
    .tabs {
      position: static;
      flex-direction: row;
      flex-wrap: wrap;
    }
  }
  h2 {
    margin-bottom: 12px;
  }
  h3 {
    margin: 24px 0 6px;
    color: var(--text-weak);
    font-size: 12px;
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 40px;
    padding: 4px 0;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hint {
    color: var(--text-weak);
    font-size: 12px;
  }
  .note {
    margin-top: 8px;
  }
  .buttons {
    display: flex;
    flex: none;
    gap: 6px;
  }
  .indent {
    padding-left: 32px;
  }
  .narrow {
    width: 110px;
  }
  .wide {
    width: min(320px, 60%);
  }
  .checks {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0;
  }
  .seg {
    display: flex;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .seg button {
    height: 28px;
    padding: 0 12px;
    border: 0;
    border-left: 1px solid var(--border-weak);
    background: none;
    color: var(--text-weak);
    cursor: pointer;
  }
  .seg button:first-child {
    border-left: 0;
  }
  .seg button.active {
    background: var(--bg-strong);
    color: var(--text-inverted);
  }
  dl {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 8px 16px;
    margin: 0;
  }
  dd {
    margin: 0;
  }
  .themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }
  .theme {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    text-align: left;
    cursor: pointer;
  }
  .theme.active {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .theme-name {
    font-size: 12px;
  }
  .last {
    white-space: nowrap;
  }
  .caret {
    display: inline-block;
    width: 7px;
    height: 13px;
    margin-left: 4px;
    vertical-align: -2px;
  }
  .swatches {
    display: flex;
    gap: 3px;
  }
  .swatches span {
    width: 12px;
    height: 12px;
    border-radius: 2px;
  }
  .looks {
    margin: 8px 0 0;
    padding: 0;
    border: 1px solid var(--border-weak);
    border-radius: var(--radius);
    list-style: none;
  }
  .look {
    display: grid;
    grid-template-columns: 90px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-top: 1px solid var(--border-weak);
  }
  .look:first-child {
    border-top: 0;
  }
</style>
