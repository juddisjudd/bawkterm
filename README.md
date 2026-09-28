# bawkterm

Personal SSH, SFTP and keychain client. Electron + Svelte 5, styled after opencode.ai.

## Run

```sh
pnpm install
pnpm dev          # hot-reload dev build
pnpm build        # production build into out/
pnpm dist         # Windows installer into dist/
pnpm typecheck
```

Try it without a real server:

```sh
pnpm test-server  # SSH + SFTP on 127.0.0.1:2222, login test / test
```

## Releases

```sh
pnpm release patch   # or minor, major, or an exact x.y.z
```

The script refuses a dirty tree or a branch other than `main`. It bumps `package.json`, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z` and pushes both. The tag starts `.github/workflows/release.yml`, which typechecks, builds the NSIS installer on Windows and publishes a GitHub Release with notes generated from the commits since the last tag. A manual run from the Actions tab builds the installer as a 7-day artifact without releasing.

The installer is unsigned, so Windows SmartScreen asks once: **More info → Run anyway**.

## Features

- **Vault**: a random vault key (AES-256-GCM) encrypts every host, key, password and trusted host key in `%APPDATA%/bawkterm/vault.json`. The master password (scrypt N=2^17) holds a wrapped copy of that key, so changing it never re-keys the vault. Optional auto-unlock uses Windows DPAPI. Auto-lock after idle minutes.
- **Windows Hello and passkey unlock**: extra ways to open the vault, each with its own wrapped copy of the vault key. Windows Hello uses a TPM-backed Hello key whose deterministic signature derives the unwrapping key. Passkeys (phone via QR, security key, or this PC) use the WebAuthn PRF extension. The app is served from `https://bawkterm.bawkbawk.net` (answered locally, never fetched) so passkeys have a valid RP ID; dev builds use `localhost`, so passkeys set up in dev do not work in the installed app.
- **SSH**: xterm.js tabs with WebGL rendering, flow control, jump hosts (chained), agent auth (OpenSSH agent or Pageant), keyboard-interactive, password and key prompts with "save to vault".
- **Terminal comforts**: auto-reconnect with backoff when a connection drops (terminal, SFTP and Docker tabs; edits saved while offline upload once back), a per-host command to run after connect, a prompt before multi-line pastes (unless the shell uses bracketed paste), scrollback search, per-tab zoom, OSC 52 copy from remote tmux/vim (write only), a bell (`!`) marker with a notification for background tabs, 12 terminal themes, and tabs reopened on launch.
- **Host keys**: trust-on-first-use with SHA256 fingerprints; a changed key blocks the connection until you approve it.
- **SFTP**: local and remote panes, drag and drop (also from Explorer), recursive upload/download/delete, rename, new folder, cancellable transfer queue. Asks Replace / Keep both / Skip when a name is taken, type-to-filter, remembers the last folder per host, favorite folders and folder colors per host (synced; favorites show as a strip under the path and in Ctrl+Shift+P), and "Open terminal here".
- **Keychain**: generate ed25519 / RSA / ECDSA keys, import OpenSSH, PEM and PuTTY keys, reusable identities (username + password/key).
- **Docker** (over SSH): containers per host grouped by Compose project, CPU and memory, start / stop / restart, shell into a container or follow its logs in a terminal tab. Falls back to `sudo -n docker` when the user is not in the docker group.
- **RDP hosts**: saved and synced with the rest of the vault; opens Windows Remote Desktop already signed in, optionally tunnelled through an SSH jump host.
- **Edit in editor** (SFTP): opens a remote file in VS Code or the Windows default app and uploads every save; asks before replacing a server copy that changed meanwhile.
- **Snippets**: saved commands; Ctrl+Shift+S runs one in the open terminal (Shift+Enter pastes without running).
- **Sync** across devices through [bawksync](../bawksync), end-to-end encrypted. Each device keeps its own master password; a one-time sync link carries the key. Newest edit wins per item. Settings stay per device.
- **Import** hosts, keys and ProxyJump from `~/.ssh/config`.

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+Shift+P | open host / quick connect (`user@host:port`); Shift+Enter opens SFTP |
| Ctrl+Shift+S | run a snippet in the terminal |
| Ctrl+Shift+F | search terminal output |
| Ctrl+= / Ctrl+- / Ctrl+0 | zoom terminal text in, out, reset |
| Ctrl+Tab | next tab |
| Ctrl+Shift+W | close tab |
| Ctrl+Shift+C / V | copy / paste in terminal (right click also copies or pastes) |
| Ctrl+Shift+L | lock vault |

## Layout

```
src/main       vault, SSH/SFTP sessions, IPC (Node side)
src/preload    typed bridge exposed as window.api
src/renderer   Svelte UI
src/shared     types shared by both sides
scripts        test server, release script, icon generator (pnpm icon)
build          app icons generated from src/renderer/src/assets/chicken.svg (dark tile default, light tile for light taskbars)
```

Set `BAWKTERM_DATA_DIR` to keep a separate vault while testing.
