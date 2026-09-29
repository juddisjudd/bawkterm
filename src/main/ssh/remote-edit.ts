import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp, rmSync, unwatchFile, watchFile, type Stats as FsStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, posix } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { EditInfo, EditState } from '@shared/types'
import { DEFAULT_APP_EDITOR } from '@shared/defaults'
import type { Prompter, Send } from '../prompts'
import type { Vault } from '../vault'
import { detectEditors } from '../editors'
import { findProgram, splitCommand, system32 } from '../system'
import { call, localName, readBounded } from './sftp-util'

const MAX_BYTES = 20 * 1024 * 1024
const POLL_MS = 700

interface Edit {
  sessionId: string
  remotePath: string
  dir: string
  localPath: string
  mtime: number
  size: number
  lastLocal: number
  uploading: boolean
  again: boolean
  pending: boolean
}

const EDIT_ROOT = join(tmpdir(), 'bawkterm-edit')

// types whose default action opens them as text; anything else could run, so it goes to Notepad or TextEdit
const SAFE_DEFAULT = new Set(
  'txt log md markdown conf cfg cnf ini toml yaml yml json jsonc csv tsv env properties sql css scss less'.split(' ')
)

function launch(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = /\.(cmd|bat)$/i.test(program)
    const bundle = process.platform === 'darwin' && /\.app\/?$/i.test(program)
    const child = script
      ? spawn(system32('cmd.exe'), ['/d', '/s', '/c', `"${[program, ...args].map((a) => `"${a}"`).join(' ')}"`], {
          windowsVerbatimArguments: true,
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        })
      : bundle
        ? spawn('/usr/bin/open', ['-a', program, ...args], { detached: true, stdio: 'ignore' })
        : spawn(program, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

// Notepad on Windows, TextEdit on macOS; on Linux the first graphical editor found on PATH
function plainEditor(): string {
  if (process.platform === 'win32') return system32('notepad.exe')
  if (process.platform === 'darwin') return '/System/Applications/TextEdit.app'
  const [name] = splitCommand(detectEditors()[0]?.command ?? '')
  if (!name) throw new Error('No text editor found. Choose one in settings → editor for "Edit in editor".')
  return name
}

async function openInEditor(path: string, command: string): Promise<void> {
  const chosen = command.trim()
  if (chosen === DEFAULT_APP_EDITOR) {
    if (!SAFE_DEFAULT.has(extname(path).slice(1).toLowerCase())) return launch(plainEditor(), [path])
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return
  }
  if (!chosen) return launch(splitCommand(detectEditors()[0]?.command ?? '')[0] ?? plainEditor(), [path])
  const [name, ...args] = splitCommand(chosen)
  const program = findProgram(name)
  if (!program) throw new Error(`Cannot find the editor "${name}". Check the editor in settings.`)
  await launch(program, [...args, path])
}

export function sweepEditFiles(): void {
  rmSync(EDIT_ROOT, { recursive: true, force: true })
}

export class RemoteEditor {
  private edits = new Map<string, Edit>()

  constructor(
    private sftpFor: (sessionId: string) => SFTPWrapper,
    private prompter: Prompter,
    private send: Send,
    private vault: Vault
  ) {
    vault.onChange((data) => data === null && this.stopIdle())
  }

  private key(sessionId: string, remotePath: string): string {
    return `${sessionId}\n${remotePath}`
  }

  private emit(edit: Pick<Edit, 'sessionId' | 'remotePath'>, state: EditState, message?: string): void {
    const info: EditInfo = {
      sessionId: edit.sessionId,
      remotePath: edit.remotePath,
      name: posix.basename(edit.remotePath),
      state,
      message,
      at: Date.now()
    }
    this.send('sftp:edit', info)
  }

  async open(sessionId: string, remotePath: string): Promise<void> {
    const editor = this.vault.get().settings.editorCommand
    const existing = this.edits.get(this.key(sessionId, remotePath))
    if (existing) {
      await openInEditor(existing.localPath, editor)
      return
    }
    const sftp = this.sftpFor(sessionId)
    const st = await call<Stats>((cb) => sftp.stat(remotePath, cb))
    if (st.isDirectory()) throw new Error('Folders cannot be opened in an editor')
    if (!st.isFile()) throw new Error('Only regular files can be opened in an editor')
    const tooLarge = 'This file is larger than 20 MB, download it instead'
    if (st.size > MAX_BYTES) throw new Error(tooLarge)

    const data = await readBounded(sftp, remotePath, MAX_BYTES, tooLarge)
    const dir = join(EDIT_ROOT, randomUUID())
    await fsp.mkdir(dir, { recursive: true })
    const localPath = join(dir, localName(posix.basename(remotePath).replace(/[^\w.-]/g, '_')))
    await fsp.writeFile(localPath, data)
    // mark as downloaded so Windows warns before running it, like a browser download
    await fsp.writeFile(`${localPath}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {})

    const edit: Edit = {
      sessionId,
      remotePath,
      dir,
      localPath,
      mtime: st.mtime,
      size: st.size,
      lastLocal: (await fsp.stat(localPath)).mtimeMs,
      uploading: false,
      again: false,
      pending: false
    }
    this.edits.set(this.key(sessionId, remotePath), edit)
    watchFile(localPath, { interval: POLL_MS }, (curr: FsStats) => {
      if (!curr.mtimeMs || curr.mtimeMs === edit.lastLocal) return
      edit.lastLocal = curr.mtimeMs
      void this.upload(edit)
    })
    this.emit(edit, 'open')
    await openInEditor(localPath, editor)
  }

  private async upload(edit: Edit): Promise<void> {
    if (edit.uploading) {
      edit.again = true
      return
    }
    edit.uploading = true
    this.emit(edit, 'uploading')
    try {
      const sftp = this.sftpFor(edit.sessionId)
      const remote = await call<Stats>((cb) => sftp.stat(edit.remotePath, cb))
      if (remote.mtime !== edit.mtime || remote.size !== edit.size) {
        const answer = await this.prompter.forSession(edit.sessionId)({
          kind: 'confirm',
          title: 'Remote file changed',
          message: `${edit.remotePath} changed on the server after you opened it. Upload your version and replace it?`,
          fields: [],
          confirmLabel: 'Replace',
          danger: true
        })
        if (!answer) {
          this.emit(edit, 'error', 'Not uploaded: the server copy changed')
          return
        }
      }
      const data = await fsp.readFile(edit.localPath)
      await call((cb) => sftp.writeFile(edit.remotePath, data, cb))
      const after = await call<Stats>((cb) => sftp.stat(edit.remotePath, cb))
      edit.mtime = after.mtime
      edit.size = after.size
      edit.pending = false
      this.emit(edit, 'uploaded')
    } catch (err) {
      edit.pending = true
      this.emit(edit, 'error', `Not uploaded yet: ${(err as Error).message}`)
    } finally {
      edit.uploading = false
      if (edit.again) {
        edit.again = false
        void this.upload(edit)
      }
    }
  }

  async stop(sessionId: string, remotePath: string): Promise<void> {
    const key = this.key(sessionId, remotePath)
    const edit = this.edits.get(key)
    if (!edit) return
    this.edits.delete(key)
    unwatchFile(edit.localPath)
    await fsp.rm(edit.dir, { recursive: true, force: true }).catch(() => {})
    this.emit(edit, 'closed')
  }

  resume(sessionId: string): void {
    for (const edit of this.edits.values()) {
      if (edit.sessionId === sessionId && edit.pending) void this.upload(edit)
    }
  }

  // edits still waiting to upload are kept so a lock never throws away unsaved work
  stopIdle(): void {
    for (const edit of [...this.edits.values()]) {
      if (!edit.pending && !edit.uploading) void this.stop(edit.sessionId, edit.remotePath)
    }
  }

  disposeAll(): void {
    for (const edit of this.edits.values()) unwatchFile(edit.localPath)
    this.edits.clear()
    sweepEditFiles()
  }

  stopSession(sessionId: string): void {
    for (const edit of [...this.edits.values()]) {
      if (edit.sessionId === sessionId) void this.stop(sessionId, edit.remotePath)
    }
  }
}
