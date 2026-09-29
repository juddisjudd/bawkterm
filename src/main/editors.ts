import { dialog, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EditorChoice } from '@shared/types'
import { findProgram } from './system'

const env = (name: string): string => process.env[name] ?? ''

function windowsCandidates(): { name: string; paths: string[] }[] {
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

// graphical editors that are usually on PATH on Linux desktops
const LINUX_EDITORS: [string, string[]][] = [
  ['Visual Studio Code', ['code']],
  ['VSCodium', ['codium']],
  ['Cursor', ['cursor']],
  ['Zed', ['zeditor', 'zed']],
  ['Sublime Text', ['subl']],
  ['Kate', ['kate']],
  ['GNOME Text Editor', ['gnome-text-editor']],
  ['gedit', ['gedit']],
  ['KWrite', ['kwrite']],
  ['Mousepad', ['mousepad']],
  ['Xed', ['xed']],
  ['Pluma', ['pluma']],
  ['Geany', ['geany']]
]

export function detectEditors(): EditorChoice[] {
  if (process.platform === 'win32') {
    return windowsCandidates().flatMap(({ name, paths }) => {
      const found = paths.find((p) => existsSync(p))
      return found ? [{ name, command: `"${found}"` }] : []
    })
  }
  return LINUX_EDITORS.flatMap(([name, commands]) => {
    const found = commands.map(findProgram).find(Boolean)
    return found ? [{ name, command: `"${found}"` }] : []
  })
}

export async function pickEditor(win: BrowserWindow): Promise<string | null> {
  const windows = process.platform === 'win32'
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a text editor',
    defaultPath: windows ? env('ProgramFiles') || undefined : '/usr/bin',
    filters: windows ? [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }] : undefined,
    properties: ['openFile']
  })
  const path = res.filePaths[0]
  return res.canceled || !path ? null : `"${path}"`
}
