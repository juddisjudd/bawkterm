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

- **Vault**: one master password encrypts every host, key, password and trusted host key (scrypt N=2^17 → AES-256-GCM, file `%APPDATA%/bawkterm/vault.json`). Optional auto-unlock uses Windows DPAPI. Auto-lock after idle minutes.
- **SSH**: xterm.js tabs with WebGL rendering, flow control, jump hosts (chained), agent auth (OpenSSH agent or Pageant), keyboard-interactive, password and key prompts with "save to vault".
- **Host keys**: trust-on-first-use with SHA256 fingerprints; a changed key blocks the connection until you approve it.
- **SFTP**: local and remote panes, drag and drop (also from Explorer), recursive upload/download/delete, rename, new folder, cancellable transfer queue.
- **Keychain**: generate ed25519 / RSA / ECDSA keys, import OpenSSH, PEM and PuTTY keys, reusable identities (username + password/key).
- **Snippets**: saved commands; Ctrl+Shift+S runs one in the open terminal (Shift+Enter pastes without running).
- **Sync** across devices through [bawksync](../bawksync), end-to-end encrypted. Each device keeps its own master password; a one-time sync link carries the key. Newest edit wins per item. Settings stay per device.
- **Import** hosts, keys and ProxyJump from `~/.ssh/config`.

## Shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+Shift+P | open host / quick connect (`user@host:port`); Shift+Enter opens SFTP |
| Ctrl+Shift+S | run a snippet in the terminal |
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
build          app icon: line art at 64px and up, pixel art below
```

Set `BAWKTERM_DATA_DIR` to keep a separate vault while testing.
