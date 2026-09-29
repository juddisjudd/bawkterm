import { dialog, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EditorChoice } from '@shared/types'

const env = (name: string): string => process.env[name] ?? ''

function candidates(): { name: string; paths: string[] }[] {
  const local = join(env('LOCALAPPDATA'), 'Programs')
  const programs = [env('ProgramFiles'), env('ProgramFiles(x86)')].filter(Boolean)
  const scoop = join(env('SCOOP') || join(homedir(), 'scoop'), 'apps')
  return [
    {
      name: 'Visual Studio Code',
      paths: [
        join(local, 'Microsoft VS Code', 'Code.exe'),
        ...programs.map((p) => join(p, 'Microsoft VS Code', 'Code.exe')),
        join(scoop, 'vscode', 'current', 'Code.exe')
      ]
    },
    { name: 'VS Code Insiders', paths: [join(local, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')] },
    { name: 'Cursor', paths: [join(local, 'cursor', 'Cursor.exe')] },
    { name: 'Windsurf', paths: [join(local, 'Windsurf', 'Windsurf.exe')] },
    { name: 'Zed', paths: [join(local, 'Zed', 'Zed.exe'), join(scoop, 'zed', 'current', 'zed.exe')] },
    {
      name: 'Sublime Text',
      paths: [
        ...programs.flatMap((p) => [join(p, 'Sublime Text', 'sublime_text.exe'), join(p, 'Sublime Text 3', 'sublime_text.exe')]),
        join(scoop, 'sublime-text', 'current', 'sublime_text.exe')
      ]
    },
    {
      name: 'Notepad++',
      paths: [...programs.map((p) => join(p, 'Notepad++', 'notepad++.exe')), join(scoop, 'notepadplusplus', 'current', 'notepad++.exe')]
    },
    { name: 'Notepad', paths: [join(env('SystemRoot') || 'C:\\Windows', 'System32', 'notepad.exe')] }
  ]
}

export function detectEditors(): EditorChoice[] {
  if (process.platform !== 'win32') return []
  return candidates().flatMap(({ name, paths }) => {
    const found = paths.find((p) => existsSync(p))
    return found ? [{ name, command: `"${found}"` }] : []
  })
}

export async function pickEditor(win: BrowserWindow): Promise<string | null> {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a text editor',
    defaultPath: env('ProgramFiles') || undefined,
    filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }],
    properties: ['openFile']
  })
  const path = res.filePaths[0]
  return res.canceled || !path ? null : `"${path}"`
}
