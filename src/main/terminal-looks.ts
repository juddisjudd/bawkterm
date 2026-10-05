import { execFile } from 'node:child_process'
import { promises as fsp, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { CursorStyle, TerminalLook, TerminalPalette } from '@shared/types'
import { POWERSHELL } from './system'

const MAX_FILE = 1024 * 1024
const MAX_DEPTH = 5
const MAX_THEMES = 50

export interface LookEnv {
  platform: NodeJS.Platform
  home: string
  vars: NodeJS.ProcessEnv
  run: (file: string, args: string[]) => Promise<string>
}

type Json = Record<string, unknown>
type Entry = [string, string]

const asObj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const asList = (v: unknown): Json[] => (Array.isArray(v) ? v.map(asObj) : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const unquote = (v: string): string => v.trim().replace(/^(['"])(.*)\1$/, '$2')

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

function run(file: string, args: string[]): Promise<string> {
  return new Promise((done) =>
    execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => done(err ? '' : String(out)))
  )
}

async function read(path: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(path)
    if (!stat.isFile() || stat.size > MAX_FILE) return null
    return await fsp.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function firstFile(paths: string[]): Promise<{ path: string; text: string } | null> {
  for (const path of paths) {
    const text = await read(path)
    if (text !== null) return { path, text }
  }
  return null
}

const expandHome = (p: string, env: LookEnv): string => p.replace(/^~(?=$|[\\/])/, env.home)
const xdgConfig = (env: LookEnv): string => env.vars.XDG_CONFIG_HOME || join(env.home, '.config')

export function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const m = unquote(value).match(/^(?:#|0x)?([0-9a-f]{6}|[0-9a-f]{3})$/i)
  if (!m) return undefined
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return `#${hex.toLowerCase()}`
}

interface RawPalette {
  background?: string
  foreground?: string
  cursor?: string
  selection?: string
  selectionText?: string
  ansi: (string | undefined)[]
}

function palette(p: RawPalette): TerminalPalette | undefined {
  const ansi = p.ansi.slice(0, 16)
  if (!p.background || !p.foreground || ansi.length < 16 || ansi.some((c) => !c)) return undefined
  return {
    background: p.background,
    foreground: p.foreground,
    ...(p.cursor ? { cursor: p.cursor } : {}),
    ...(p.selection ? { selection: p.selection } : {}),
    ...(p.selectionText ? { selectionText: p.selectionText } : {}),
    ansi: ansi as string[]
  }
}

// terminals size fonts in points; a CSS pixel is a point on macOS and three quarters of one elsewhere
function pointsToPx(value: unknown, platform: NodeJS.Platform): number | undefined {
  const pt = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(pt) || pt <= 0) return undefined
  return Math.round(platform === 'darwin' ? pt : (pt * 4) / 3)
}

const fonts = (...names: (string | undefined)[]): string[] | undefined => {
  const list = [...new Set(names.filter((n): n is string => !!n))]
  return list.length ? list : undefined
}

// Windows Terminal writes JSON with comments and trailing commas
export function parseJsonc(text: string): unknown {
  const scan = (src: string, other: (i: number, out: string[]) => number): string => {
    const out: string[] = []
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '"') {
        let j = i + 1
        while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
        out.push(src.slice(i, j + 1))
        i = j
      } else {
        i = other(i, out)
      }
    }
    return out.join('')
  }
  const noComments = scan(text, (i, out) => {
    if (text[i] === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      return end < 0 ? text.length : end - 1
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      return end < 0 ? text.length : end + 1
    }
    out.push(text[i])
    return i
  })
  const clean = scan(noComments, (i, out) => {
    if (noComments[i] === ',') {
      const next = noComments.slice(i + 1).match(/^\s*(.)/)?.[1]
      if (next === '}' || next === ']') return i
    }
    out.push(noComments[i])
    return i
  })
  return JSON.parse(clean)
}

const WT_BASE = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white']
const WT_KEYS = [...WT_BASE, ...WT_BASE.map((k) => `bright${k[0].toUpperCase()}${k.slice(1)}`)]
const WT_CURSOR: Record<string, CursorStyle> = {
  bar: 'bar',
  underscore: 'underline',
  doubleUnderscore: 'underline',
  vintage: 'underline',
  filledBox: 'block',
  emptyBox: 'block'
}
const CAMPBELL: Json = {
  name: 'Campbell',
  foreground: '#CCCCCC',
  background: '#0C0C0C',
  cursorColor: '#FFFFFF',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  purple: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightPurple: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2'
}

export async function wtLook(terminal: string, text: string, builtins: () => Promise<unknown>): Promise<TerminalLook | null> {
  let settings: Json
  try {
    settings = asObj(parseJsonc(text))
  } catch {
    return null
  }
  const profiles = Array.isArray(settings.profiles) ? { list: settings.profiles } : asObj(settings.profiles)
  const list = asList(profiles.list)
  const profile = list.find((p) => p.guid === settings.defaultProfile || p.name === settings.defaultProfile) ?? list[0] ?? {}
  const base = asObj(profiles.defaults)
  const pick = (key: string): unknown => profile[key] ?? base[key]
  const font = { ...asObj(base.font), ...asObj(profile.font) }
  const schemeSetting = pick('colorScheme')
  const name = str(schemeSetting) ?? str(asObj(schemeSetting).dark) ?? 'Campbell'
  const scheme =
    asList(settings.schemes).find((s) => s.name === name) ??
    asList(asObj(await builtins()).schemes).find((s) => s.name === name) ??
    (name === 'Campbell' ? CAMPBELL : {})
  const color = (key: string, schemeKey = key): string | undefined => hexColor(pick(key)) ?? hexColor(scheme[schemeKey])
  return {
    terminal,
    name,
    palette: palette({
      background: color('background'),
      foreground: color('foreground'),
      cursor: color('cursorColor'),
      selection: color('selectionBackground'),
      ansi: WT_KEYS.map((k) => hexColor(scheme[k]))
    }),
    fonts: fonts(str(font.face) ?? str(pick('fontFace')) ?? 'Cascadia Mono'),
    fontSize: pointsToPx(font.size ?? pick('fontSize') ?? 12, 'win32'),
    cursorStyle: WT_CURSOR[str(pick('cursorShape')) ?? 'bar']
  }
}

async function windowsTerminal(env: LookEnv): Promise<TerminalLook[]> {
  if (env.platform !== 'win32') return []
  const local = env.vars.LOCALAPPDATA || join(env.home, 'AppData', 'Local')
  const looks: TerminalLook[] = []
  for (const [terminal, pkg] of [
    ['Windows Terminal', 'Microsoft.WindowsTerminal'],
    ['Windows Terminal Preview', 'Microsoft.WindowsTerminalPreview']
  ]) {
    const text = await read(join(local, 'Packages', `${pkg}_8wekyb3d8bbwe`, 'LocalState', 'settings.json'))
    if (text === null) continue
    // the built-in schemes live in defaults.json inside the app package
    const builtins = async (): Promise<unknown> => {
      const dir = (await env.run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `(Get-AppxPackage -Name ${pkg}).InstallLocation`])).trim()
      const defaults = dir ? await read(join(dir, 'defaults.json')) : null
      try {
        return defaults ? parseJsonc(defaults) : {}
      } catch {
        return {}
      }
    }
    const look = await wtLook(terminal, text, builtins)
    if (look) looks.push(look)
  }
  if (!looks.length) {
    const text = await read(join(local, 'Microsoft', 'Windows Terminal', 'settings.json'))
    const look = text === null ? null : await wtLook('Windows Terminal', text, async () => ({}))
    if (look) looks.push(look)
  }
  return looks
}

function deepMerge(a: Json, b: Json): Json {
  const out: Json = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key]
    out[key] =
      prev && value && typeof prev === 'object' && typeof value === 'object' && !Array.isArray(prev) && !Array.isArray(value)
        ? deepMerge(prev as Json, value as Json)
        : value
  }
  return out
}

async function alacrittyConfig(path: string, text: string, env: LookEnv, depth: number): Promise<{ config: Json; theme?: string }> {
  let config: Json
  try {
    config = parseToml(text) as Json
  } catch {
    return { config: {} }
  }
  const imports = asObj(config.general).import ?? config.import
  let merged: Json = {}
  let theme: string | undefined
  if (Array.isArray(imports) && depth < MAX_DEPTH) {
    for (const item of imports) {
      if (typeof item !== 'string') continue
      const target = resolve(dirname(path), expandHome(item, env))
      const body = await read(target)
      if (body === null) continue
      const sub = await alacrittyConfig(target, body, env, depth + 1)
      merged = deepMerge(merged, sub.config)
      if (sub.config.colors) theme = basename(target, extname(target))
      theme = sub.theme ?? theme
    }
  }
  if (asObj(config.colors).normal) theme = undefined
  return { config: deepMerge(merged, config), theme }
}

const ALACRITTY_CURSOR: Record<string, CursorStyle> = { block: 'block', underline: 'underline', beam: 'bar' }

export function alacrittyLook(config: Json, theme: string | undefined, platform: NodeJS.Platform): TerminalLook {
  const colors = asObj(config.colors)
  const primary = asObj(colors.primary)
  const selection = asObj(colors.selection)
  const font = asObj(config.font)
  const style = asObj(config.cursor).style
  const shape = str(style) ?? str(asObj(style).shape)
  const blinking = str(asObj(style).blinking)?.toLowerCase()
  return {
    terminal: 'Alacritty',
    name: theme ?? 'Alacritty',
    palette: palette({
      background: hexColor(primary.background),
      foreground: hexColor(primary.foreground),
      cursor: hexColor(asObj(colors.cursor).cursor),
      selection: hexColor(selection.background),
      selectionText: hexColor(selection.text),
      ansi: [...ANSI_NAMES.map((n) => hexColor(asObj(colors.normal)[n])), ...ANSI_NAMES.map((n) => hexColor(asObj(colors.bright)[n]))]
    }),
    fonts: fonts(str(asObj(font.normal).family)),
    fontSize: pointsToPx(font.size, platform),
    cursorStyle: shape ? ALACRITTY_CURSOR[shape.toLowerCase()] : undefined,
    cursorBlink: blinking === 'on' || blinking === 'always' ? true : blinking === 'off' || blinking === 'never' ? false : undefined
  }
}

async function alacritty(env: LookEnv): Promise<TerminalLook[]> {
  const paths =
    env.platform === 'win32'
      ? [join(env.vars.APPDATA || join(env.home, 'AppData', 'Roaming'), 'alacritty', 'alacritty.toml')]
      : [
          join(xdgConfig(env), 'alacritty', 'alacritty.toml'),
          join(xdgConfig(env), 'alacritty.toml'),
          join(env.home, '.config', 'alacritty', 'alacritty.toml'),
          join(env.home, '.alacritty.toml')
        ]
  const found = await firstFile(paths)
  if (!found) return []
  const { config, theme } = await alacrittyConfig(found.path, found.text, env, 0)
  return [alacrittyLook(config, theme, env.platform)]
}

// "key = value" lines, shared by Ghostty configs and theme files
function ghosttyEntries(text: string): Entry[] {
  const out: Entry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    out.push([line.slice(0, eq).trim(), unquote(line.slice(eq + 1))])
  }
  return out
}

async function ghosttyFile(path: string, env: LookEnv, depth: number): Promise<Entry[] | null> {
  const text = await read(path)
  if (text === null) return null
  const entries = ghosttyEntries(text)
  const out = entries.filter(([key]) => key !== 'config-file')
  if (depth >= MAX_DEPTH) return out
  // included files load after the file that names them, so their values win
  for (const [, value] of entries.filter(([key]) => key === 'config-file')) {
    const target = value.replace(/^\?/, '')
    out.push(...((await ghosttyFile(resolve(dirname(path), expandHome(target, env)), env, depth + 1)) ?? []))
  }
  return out
}

function ghosttyThemeName(value: string): string {
  const parts = value.split(',').map((p) => p.trim())
  const dark = parts.find((p) => p.startsWith('dark:'))
  return (dark ?? parts.find((p) => !p.startsWith('light:')) ?? parts[0]).replace(/^(dark|light):/, '')
}

const GHOSTTY_CURSOR: Record<string, CursorStyle> = { block: 'block', block_hollow: 'block', bar: 'bar', underline: 'underline' }

export function ghosttyLook(entries: Entry[], theme: string | undefined, platform: NodeJS.Platform): TerminalLook {
  const ansi: (string | undefined)[] = Array(16).fill(undefined)
  const values: Record<string, string> = {}
  let families: string[] = []
  for (const [key, value] of entries) {
    if (key === 'palette') {
      const m = value.match(/^(\d+)\s*=\s*(.+)$/)
      if (m && Number(m[1]) < 16) ansi[Number(m[1])] = hexColor(m[2])
    } else if (key === 'font-family') {
      families = value ? [...families, value] : []
    } else {
      values[key] = value
    }
  }
  const blink = values['cursor-style-blink']
  return {
    terminal: 'Ghostty',
    name: theme ?? 'Ghostty',
    palette: palette({
      background: hexColor(values.background),
      foreground: hexColor(values.foreground),
      cursor: hexColor(values['cursor-color']),
      selection: hexColor(values['selection-background']),
      selectionText: hexColor(values['selection-foreground']),
      ansi
    }),
    fonts: fonts(families[0]),
    fontSize: pointsToPx(values['font-size'], platform),
    cursorStyle: GHOSTTY_CURSOR[values['cursor-style'] ?? ''],
    cursorBlink: blink === 'true' ? true : blink === 'false' ? false : undefined
  }
}

async function ghostty(env: LookEnv): Promise<TerminalLook[]> {
  const dirs = [join(xdgConfig(env), 'ghostty')]
  if (env.platform === 'darwin') dirs.push(join(env.home, 'Library', 'Application Support', 'com.mitchellh.ghostty'))
  const entries: Entry[] = []
  let found = false
  for (const dir of dirs) {
    for (const file of ['config', 'config.ghostty']) {
      const got = await ghosttyFile(join(dir, file), env, 0)
      if (!got) continue
      found = true
      entries.push(...got)
    }
  }
  if (!found) return []
  const themeValue = entries.filter(([key]) => key === 'theme').at(-1)?.[1]
  const theme = themeValue ? ghosttyThemeName(themeValue) : undefined
  let themeEntries: Entry[] = []
  if (theme && (isAbsolute(theme) || !/[\\/]/.test(theme))) {
    const resources = env.vars.GHOSTTY_RESOURCES_DIR
    const candidates = isAbsolute(theme)
      ? [theme]
      : [
          join(xdgConfig(env), 'ghostty', 'themes', theme),
          ...(resources ? [join(resources, 'themes', theme)] : []),
          ...(env.platform === 'darwin'
            ? ['/Applications/Ghostty.app/Contents/Resources/ghostty/themes', join(env.home, 'Applications/Ghostty.app/Contents/Resources/ghostty/themes')]
            : ['/usr/share/ghostty/themes', '/usr/local/share/ghostty/themes', join(env.home, '.local/share/ghostty/themes')]
          ).map((d) => join(d, theme))
        ]
    const file = await firstFile(candidates)
    if (file) themeEntries = ghosttyEntries(file.text)
  }
  return [ghosttyLook([...themeEntries, ...entries], theme && basename(theme), env.platform)]
}

async function kittyFile(path: string, env: LookEnv, depth: number, out: { entries: Entry[]; name?: string }): Promise<void> {
  const text = await read(path)
  if (text === null) return
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const named = line.match(/^##\s*name:\s*(.+)$/)
    if (named) out.name = named[1].trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    if (m[1] === 'include') {
      if (depth < MAX_DEPTH) await kittyFile(resolve(dirname(path), expandHome(m[2].trim(), env)), env, depth + 1, out)
    } else {
      out.entries.push([m[1], m[2].trim()])
    }
  }
}

const KITTY_CURSOR: Record<string, CursorStyle> = { block: 'block', beam: 'bar', underline: 'underline' }

export function kittyLook(entries: Entry[], name: string | undefined, platform: NodeJS.Platform): TerminalLook {
  const values = Object.fromEntries(entries)
  const family = values.font_family
  const blink = Number(values.cursor_blink_interval)
  return {
    terminal: 'Kitty',
    name: name ?? 'Kitty',
    palette: palette({
      background: hexColor(values.background),
      foreground: hexColor(values.foreground),
      cursor: hexColor(values.cursor),
      selection: hexColor(values.selection_background),
      selectionText: hexColor(values.selection_foreground),
      ansi: Array.from({ length: 16 }, (_, i) => hexColor(values[`color${i}`]))
    }),
    fonts: fonts(family && family !== 'monospace' ? unquote(family.match(/family=(["'])(.+?)\1/)?.[2] ?? family) : undefined),
    fontSize: pointsToPx(values.font_size, platform),
    cursorStyle: KITTY_CURSOR[values.cursor_shape ?? ''],
    cursorBlink: values.cursor_blink_interval === undefined || !Number.isFinite(blink) ? undefined : blink !== 0
  }
}

async function kitty(env: LookEnv): Promise<TerminalLook[]> {
  const paths = [
    ...(env.vars.KITTY_CONFIG_DIRECTORY ? [join(env.vars.KITTY_CONFIG_DIRECTORY, 'kitty.conf')] : []),
    join(xdgConfig(env), 'kitty', 'kitty.conf'),
    ...(env.platform === 'darwin' ? [join(env.home, 'Library', 'Preferences', 'kitty', 'kitty.conf')] : [])
  ]
  const found = await firstFile(paths)
  if (!found) return []
  const out: { entries: Entry[]; name?: string } = { entries: [] }
  await kittyFile(found.path, env, 0, out)
  return [kittyLook(out.entries, out.name, env.platform)]
}

function luaTable(text: string, start: number): string | undefined {
  const open = text.indexOf('{', start)
  if (open < 0) return undefined
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return undefined
}

const luaStrings = (body: string | undefined): string[] => [...(body ?? '').matchAll(/(['"])(.*?)\1/g)].map((m) => m[2])

function luaTopLevel(body: string): string {
  let depth = 0
  let out = ''
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (depth === 0) out += ch
  }
  return out
}

const WEZTERM_CURSOR: Record<string, CursorStyle> = { Block: 'block', Underline: 'underline', Bar: 'bar' }

// the config is Lua code, so only plain literal settings are read
export function weztermLook(source: string, platform: NodeJS.Platform): TerminalLook {
  const text = source.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '')
  const font = text.match(/wezterm\.font(?:_with_fallback)?\s*\(?\s*\{?\s*(?:family\s*=\s*)?(['"])(.+?)\1/)?.[2]
  const cursor = text.match(/\bdefault_cursor_style\s*=\s*(['"])(Blinking|Steady)(Block|Underline|Bar)\1/)
  const colorsAt = text.search(/\bcolors\s*=\s*\{/)
  const colors = colorsAt < 0 ? undefined : luaTable(text, colorsAt)
  const top = colors ? luaTopLevel(colors) : ''
  const field = (key: string): string | undefined => hexColor(top.match(new RegExp(`\\b${key}\\s*=\\s*(['"])(.+?)\\1`))?.[2])
  const list = (key: string): (string | undefined)[] => {
    const at = colors?.search(new RegExp(`\\b${key}\\s*=\\s*\\{`)) ?? -1
    return at < 0 || !colors ? [] : luaStrings(luaTable(colors, at)).map(hexColor)
  }
  return {
    terminal: 'WezTerm',
    name: 'WezTerm',
    palette: colors
      ? palette({
          background: field('background'),
          foreground: field('foreground'),
          cursor: field('cursor_bg'),
          selection: field('selection_bg'),
          selectionText: field('selection_fg'),
          ansi: [...list('ansi'), ...list('brights')]
        })
      : undefined,
    scheme: text.match(/\bcolor_scheme\s*=\s*(['"])(.+?)\1/)?.[2],
    fonts: fonts(font),
    fontSize: pointsToPx(text.match(/\bfont_size\s*=\s*([\d.]+)/)?.[1], platform),
    cursorStyle: cursor ? WEZTERM_CURSOR[cursor[3]] : undefined,
    cursorBlink: cursor ? cursor[2] === 'Blinking' : undefined
  }
}

async function wezterm(env: LookEnv): Promise<TerminalLook[]> {
  const found = await firstFile([
    ...(env.vars.WEZTERM_CONFIG_FILE ? [env.vars.WEZTERM_CONFIG_FILE] : []),
    join(xdgConfig(env), 'wezterm', 'wezterm.lua'),
    join(env.home, '.wezterm.lua')
  ])
  return found ? [weztermLook(found.text, env.platform)] : []
}

function itermColor(value: unknown): string | undefined {
  const c = asObj(value)
  const channels = ['Red Component', 'Green Component', 'Blue Component'].map((k) => c[k])
  if (!channels.every((v) => typeof v === 'number')) return undefined
  return '#' + (channels as number[]).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')
}

const ITERM_CURSOR: CursorStyle[] = ['underline', 'bar', 'block']

export function itermLook(profiles: unknown, guid: string): TerminalLook | null {
  const list = asList(profiles)
  const profile = list.find((p) => p.Guid === guid) ?? list[0]
  if (!profile) return null
  const dark = profile['Use Separate Colors for Light and Dark Mode'] === true
  const color = (key: string): string | undefined => itermColor((dark && profile[`${key} (Dark)`]) || profile[key])
  // "Normal Font" holds a PostScript name and a size, such as "JetBrainsMono-Regular 13"
  const font = str(profile['Normal Font'])?.match(/^(.*\S)\s+([\d.]+)$/)
  const ps = font?.[1].replace(/-(Regular|Book|Roman|Medium|Light|Text|Retina)$/i, '')
  const cursor = profile['Cursor Type']
  return {
    terminal: 'iTerm2',
    name: str(profile.Name) ?? 'iTerm2',
    palette: palette({
      background: color('Background Color'),
      foreground: color('Foreground Color'),
      cursor: color('Cursor Color'),
      selection: color('Selection Color'),
      selectionText: color('Selected Text Color'),
      ansi: Array.from({ length: 16 }, (_, i) => color(`Ansi ${i} Color`))
    }),
    fonts: ps
      ? fonts(
          ps,
          ps.replace(/-/g, ' ').replace(/([a-z])([A-Z][a-z]+)$/, '$1 $2'),
          ps.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' ')
        )
      : undefined,
    fontSize: pointsToPx(font?.[2], 'darwin'),
    cursorStyle: typeof cursor === 'number' ? ITERM_CURSOR[cursor] : undefined,
    cursorBlink: typeof profile['Blinking Cursor'] === 'boolean' ? profile['Blinking Cursor'] : undefined
  }
}

async function iterm2(env: LookEnv): Promise<TerminalLook[]> {
  if (env.platform !== 'darwin') return []
  const plist = join(env.home, 'Library', 'Preferences', 'com.googlecode.iterm2.plist')
  try {
    await fsp.access(plist)
  } catch {
    return []
  }
  const json = await env.run('/usr/bin/plutil', ['-extract', 'New Bookmarks', 'json', '-o', '-', plist])
  const guid = (await env.run('/usr/bin/plutil', ['-extract', 'Default Bookmark Guid', 'raw', '-o', '-', plist])).trim()
  try {
    const look = itermLook(JSON.parse(json), guid)
    return look ? [look] : []
  } catch {
    return []
  }
}

// block mappings of plain scalars, which is all a Warp theme file uses
export function parseSimpleYaml(text: string): Json {
  const root: Json = {}
  const stack: { indent: number; node: Json }[] = [{ indent: -1, node: root }]
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const m = line.trim().match(/^([^:]+):\s*(.*)$/)
    if (!m) continue
    while (stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1].node
    const key = unquote(m[1])
    if (m[2] === '') {
      const child: Json = {}
      parent[key] = child
      stack.push({ indent, node: child })
    } else {
      parent[key] = unquote(m[2])
    }
  }
  return root
}

export function warpLook(text: string, file: string): TerminalLook {
  const theme = parseSimpleYaml(text)
  const colors = asObj(theme.terminal_colors)
  const accent = hexColor(theme.accent)
  return {
    terminal: 'Warp',
    name: str(theme.name) ?? basename(file, extname(file)),
    palette: palette({
      background: hexColor(theme.background),
      foreground: hexColor(theme.foreground),
      cursor: accent,
      ansi: [...ANSI_NAMES.map((n) => hexColor(asObj(colors.normal)[n])), ...ANSI_NAMES.map((n) => hexColor(asObj(colors.bright)[n]))]
    })
  }
}

async function warp(env: LookEnv): Promise<TerminalLook[]> {
  const dir =
    env.platform === 'darwin'
      ? join(env.home, '.warp', 'themes')
      : env.platform === 'win32'
        ? join(env.vars.LOCALAPPDATA || join(env.home, 'AppData', 'Local'), 'warp', 'Warp', 'data', 'themes')
        : join(env.vars.XDG_DATA_HOME || join(env.home, '.local', 'share'), 'warp-terminal', 'themes')
  const files: string[] = []
  const walk = async (path: string, depth: number): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_THEMES) return
      const full = join(path, entry.name)
      if (entry.isDirectory() && depth < 1) await walk(full, depth + 1)
      else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(full)
    }
  }
  await walk(dir, 0)
  const looks: TerminalLook[] = []
  for (const file of files) {
    const text = await read(file)
    if (text === null) continue
    const look = warpLook(text, file)
    if (look.palette) looks.push(look)
  }
  return looks
}

const READERS = [windowsTerminal, alacritty, ghostty, kitty, wezterm, iterm2, warp]

export async function detectTerminalLooks(
  env: LookEnv = { platform: process.platform, home: homedir(), vars: process.env, run }
): Promise<TerminalLook[]> {
  const results = await Promise.all(READERS.map((reader) => reader(env).catch(() => [])))
  return results.flat()
}
