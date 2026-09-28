<script lang="ts">
  import type { CursorStyle, Settings, ThemeSetting } from '@shared/types'
  import { app } from '$lib/state.svelte'
  import PageHeader from './PageHeader.svelte'
  import Checkbox from './Checkbox.svelte'
  import SyncSettings from './SyncSettings.svelte'
  import { TERMINAL_THEMES } from '$lib/theme'

  const s = $derived(app.settings)

  async function set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    await window.api.settings.save({ ...app.settings, [key]: value }).catch((err) => app.fail(err))
  }

  function num(e: Event, min: number, max: number): number | null {
    const n = Number((e.currentTarget as HTMLInputElement).value)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
  }

  async function setRemember(on: boolean): Promise<void> {
    try {
      app.status = await window.api.vault.setRemember(on)
    } catch (err) {
      app.fail(err)
    }
  }

  async function changePassword(): Promise<void> {
    const res = await app.ask({
      title: 'Change master password',
      message: 'The vault is re-encrypted with the new password.',
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
      app.toast('Master password changed')
    } catch (err) {
      app.fail(err)
    }
  }

  async function importConfig(): Promise<void> {
    try {
      const res = await window.api.importSshConfig()
      app.toast(`Imported ${res.hosts} hosts and ${res.keys} keys`)
      if (res.skipped.length) app.toast(`Skipped: ${res.skipped.slice(0, 3).join('; ')}`, 'error')
    } catch (err) {
      app.fail(err)
    }
  }

  const themes: ThemeSetting[] = ['system', 'dark', 'light']
  const cursors: CursorStyle[] = ['block', 'bar', 'underline']
</script>

<div class="page">
  <PageHeader title="settings" subtitle="Saved inside the encrypted vault." />

  <SyncSettings />

  <section>
    <h2>appearance</h2>
    <div class="row">
      <span>theme</span>
      <div class="seg">
        {#each themes as t (t)}
          <button type="button" class:active={s.theme === t} onclick={() => set('theme', t)}>{t}</button>
        {/each}
      </div>
    </div>
  </section>

  <section>
    <h2>terminal</h2>
    <div class="themes" role="radiogroup" aria-label="terminal theme">
      {#each TERMINAL_THEMES as t (t.id)}
        <button
          type="button"
          role="radio"
          aria-checked={s.terminalTheme === t.id}
          class={['theme', s.terminalTheme === t.id && 'active']}
          style:background={t.colors.background}
          style:color={t.colors.foreground}
          onclick={() => set('terminalTheme', t.id)}
        >
          <span class="theme-name">{t.label}</span>
          <span class="swatches">
            {#each [t.colors.red, t.colors.green, t.colors.yellow, t.colors.blue, t.colors.magenta, t.colors.cyan] as c, i (i)}
              <span style:background={c}></span>
            {/each}
          </span>
        </button>
      {/each}
    </div>
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
    <label class="row">
      <span>font family</span>
      <input class="input wide" value={s.terminalFontFamily} spellcheck="false"
        onchange={(e) => set('terminalFontFamily', e.currentTarget.value || '"IBM Plex Mono", monospace')} />
    </label>
    <div class="row">
      <span>cursor</span>
      <div class="seg">
        {#each cursors as c (c)}
          <button type="button" class:active={s.cursorStyle === c} onclick={() => set('cursorStyle', c)}>{c}</button>
        {/each}
      </div>
    </div>
    <label class="row">
      <span>scrollback lines</span>
      <input class="input narrow" type="number" min="500" max="200000" step="500" value={s.scrollback}
        onchange={(e) => { const n = num(e, 500, 200000); if (n) set('scrollback', n) }} />
    </label>
    <div class="checks">
      <Checkbox checked={s.cursorBlink} label="blinking cursor" onchange={(v) => set('cursorBlink', v)} />
      <Checkbox checked={s.copyOnSelect} label="copy text when selected" onchange={(v) => set('copyOnSelect', v)} />
      <Checkbox checked={s.rightClickPaste} label="right click copies selection or pastes" onchange={(v) => set('rightClickPaste', v)} />
      <Checkbox checked={s.pasteProtection} label="ask before pasting several lines into a shell" onchange={(v) => set('pasteProtection', v)} />
      <Checkbox checked={s.osc52} label="let remote programs (tmux, vim) copy to my clipboard" onchange={(v) => set('osc52', v)} />
      <Checkbox checked={s.bellNotify} label="notify when a background tab rings the bell" onchange={(v) => set('bellNotify', v)} />
      <Checkbox checked={s.autoReconnect} label="reconnect automatically when a connection drops" onchange={(v) => set('autoReconnect', v)} />
      <Checkbox checked={s.restoreTabs} label="reopen my tabs when bawkterm starts" onchange={(v) => set('restoreTabs', v)} />
    </div>
  </section>

  <section>
    <h2>connections</h2>
    <label class="row">
      <span>keepalive interval (seconds, 0 = off)</span>
      <input class="input narrow" type="number" min="0" max="600" value={s.keepAliveSec}
        onchange={(e) => { const n = num(e, 0, 600); if (n !== null) set('keepAliveSec', n) }} />
    </label>
    <div class="checks">
      <Checkbox checked={s.sftpShowHidden} label="show hidden files in sftp" onchange={(v) => set('sftpShowHidden', v)} />
    </div>
    <label class="row">
      <span>editor for "Edit in editor" (empty = VS Code if installed, else Windows default)</span>
      <input class="input wide" value={s.editorCommand} placeholder="code" spellcheck="false"
        onchange={(e) => set('editorCommand', e.currentTarget.value.trim())} />
    </label>
    <div class="row">
      <span>import hosts and keys from ~/.ssh/config</span>
      <button type="button" class="btn" onclick={importConfig}>Import</button>
    </div>
  </section>

  <section>
    <h2>security</h2>
    <label class="row">
      <span>auto-lock after idle minutes (0 = never)</span>
      <input class="input narrow" type="number" min="0" max="1440" value={s.autoLockMinutes}
        onchange={(e) => { const n = num(e, 0, 1440); if (n !== null) set('autoLockMinutes', n) }} />
    </label>
    {#if app.status?.canRemember}
      <div class="checks">
        <Checkbox checked={app.status.remembered} label="unlock automatically on this device (uses Windows DPAPI)" onchange={setRemember} />
      </div>
    {/if}
    <div class="row">
      <span>master password</span>
      <button type="button" class="btn" onclick={changePassword}>Change…</button>
    </div>
  </section>

  <section>
    <h2>shortcuts</h2>
    <dl>
      <dt><span class="kbd">ctrl+shift+p</span></dt><dd>open host / quick connect</dd>
      <dt><span class="kbd">ctrl+shift+s</span></dt><dd>run a snippet in the terminal</dd>
      <dt><span class="kbd">ctrl+shift+f</span></dt><dd>search terminal output</dd>
      <dt><span class="kbd">ctrl+= / - / 0</span></dt><dd>zoom terminal text in, out, reset</dd>
      <dt><span class="kbd">ctrl+tab</span></dt><dd>next tab</dd>
      <dt><span class="kbd">ctrl+shift+w</span></dt><dd>close tab</dd>
      <dt><span class="kbd">ctrl+shift+c / v</span></dt><dd>copy / paste in terminal</dd>
      <dt><span class="kbd">ctrl+shift+l</span></dt><dd>lock vault</dd>
    </dl>
  </section>

  <p class="version muted">bawkterm v{__APP_VERSION__}</p>
</div>

<style>
  .page {
    max-width: 760px;
    padding: 32px 40px 64px;
  }
  section {
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border-weak);
  }
  h2 {
    margin-bottom: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 40px;
  }
  .narrow {
    width: 110px;
  }
  .wide {
    width: 320px;
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
    margin-bottom: 14px;
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
    outline: 2px solid var(--bg-interactive);
    outline-offset: 1px;
  }
  .theme-name {
    font-size: 12px;
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
  .version {
    font-size: 12px;
  }
</style>
