import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  label: string
  dark: boolean
  colors: ITheme
  // the app's own palette, used as-is when the app theme matches the terminal
  builtin?: boolean
  accent: string
}

type Lch = [number, number, number]

function toLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc
  ]
}

function linearToHex(linear: number[]): string {
  const channel = (v: number): string => {
    const x = Math.min(1, Math.max(0, v))
    const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
    return Math.round(srgb * 255).toString(16).padStart(2, '0')
  }
  return '#' + linear.map(channel).join('')
}

// xterm only accepts hex, so the opencode palettes are written in OKLCH and converted here
function oklch(l: number, c: number, h: number): string {
  return linearToHex(toLinear(l, c, h))
}

// like oklch(), but lowers chroma instead of clipping, so derived colors keep their hue and lightness
function fit([l, c, h]: Lch): string {
  const L = Math.min(1, Math.max(0, l))
  const inGamut = (chroma: number): boolean => toLinear(L, chroma, h).every((v) => v >= -0.0001 && v <= 1.0001)
  if (inGamut(c)) return linearToHex(toLinear(L, c, h))
  let lo = 0
  let hi = c
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(mid)) lo = mid
    else hi = mid
  }
  return linearToHex(toLinear(L, lo, h))
}

function linearRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
}

function toLch(hex: string): Lch {
  const [r, g, b] = linearRgb(hex)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]
}

function contrast(a: string, b: string): number {
  const y = (hex: string): number => {
    const [r, g, bl] = linearRgb(hex)
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [y(a), y(b)].sort((x, z) => z - x)
  return (hi + 0.05) / (lo + 0.05)
}

// moves a color away from the background until it meets the WCAG contrast ratio
function readable(color: string | Lch, bg: string, min: number, dir: 1 | -1): string {
  const [l, c, h] = typeof color === 'string' ? toLch(color) : color
  for (let step = 0; step <= 100; step++) {
    const hex = fit([l + dir * step * 0.01, c, h])
    if (contrast(hex, bg) >= min || l + dir * step * 0.01 >= 1 || l + dir * step * 0.01 <= 0) return hex
  }
  return fit([dir > 0 ? 1 : 0, 0, h])
}

function mix(a: string, b: string, t: number): Lch {
  const [l1, c1, h1] = toLch(a)
  const [l2, c2, h2] = toLch(b)
  const dh = ((h2 - h1 + 540) % 360) - 180
  return [l1 + (l2 - l1) * t, c1 + (c2 - c1) * t, (h1 + dh * t + 360) % 360]
}

const opencode: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: oklch(0.175, 0.006, 25),
    foreground: oklch(0.92, 0.005, 25),
    cursor: oklch(0.955, 0.005, 25),
    cursorAccent: oklch(0.175, 0.006, 25),
    selectionBackground: oklch(0.965, 0.09, 108),
    selectionForeground: oklch(0.175, 0.006, 25),
    selectionInactiveBackground: oklch(0.78, 0.07, 105),
    black: oklch(0.3, 0.006, 25),
    red: oklch(0.72, 0.16, 20),
    green: oklch(0.8, 0.15, 150),
    yellow: oklch(0.8, 0.14, 70),
    blue: oklch(0.7, 0.13, 255),
    magenta: oklch(0.7, 0.14, 300),
    cyan: oklch(0.76, 0.1, 205),
    white: oklch(0.8, 0.008, 25),
    brightBlack: oklch(0.6, 0.008, 25),
    brightRed: oklch(0.78, 0.12, 20),
    brightGreen: oklch(0.87, 0.12, 150),
    brightYellow: oklch(0.88, 0.12, 90),
    brightBlue: oklch(0.78, 0.11, 255),
    brightMagenta: oklch(0.78, 0.11, 300),
    brightCyan: oklch(0.84, 0.09, 205),
    brightWhite: oklch(0.955, 0.005, 25)
  },
  light: {
    background: oklch(0.99, 0.002, 25),
    foreground: oklch(0.24, 0.006, 25),
    cursor: oklch(0.24, 0.006, 25),
    cursorAccent: oklch(0.99, 0.002, 25),
    selectionBackground: oklch(0.92, 0.11, 108),
    selectionForeground: oklch(0.21, 0.006, 25),
    selectionInactiveBackground: oklch(0.93, 0.04, 105),
    black: oklch(0.24, 0.006, 25),
    red: oklch(0.53, 0.19, 25),
    green: oklch(0.5, 0.13, 150),
    yellow: oklch(0.55, 0.12, 70),
    blue: oklch(0.52, 0.15, 258),
    magenta: oklch(0.5, 0.17, 300),
    cyan: oklch(0.52, 0.09, 205),
    white: oklch(0.55, 0.006, 25),
    brightBlack: oklch(0.42, 0.006, 25),
    brightRed: oklch(0.57, 0.19, 25),
    brightGreen: oklch(0.54, 0.14, 150),
    brightYellow: oklch(0.56, 0.13, 55),
    brightBlue: oklch(0.55, 0.16, 258),
    brightMagenta: oklch(0.56, 0.15, 300),
    brightCyan: oklch(0.55, 0.09, 200),
    brightWhite: oklch(0.66, 0.006, 25)
  }
}

export const SEARCH_DECORATIONS = {
  dark: {
    matchBackground: oklch(0.34, 0.05, 105),
    matchOverviewRuler: oklch(0.6, 0.1, 100),
    activeMatchBackground: oklch(0.8, 0.13, 100),
    activeMatchColorOverviewRuler: oklch(0.965, 0.09, 108)
  },
  light: {
    matchBackground: oklch(0.93, 0.07, 105),
    matchOverviewRuler: oklch(0.8, 0.12, 100),
    activeMatchBackground: oklch(0.86, 0.13, 100),
    activeMatchColorOverviewRuler: oklch(0.55, 0.13, 100)
  }
}

export const TERMINAL_THEMES: TerminalTheme[] = [
  { id: 'auto', label: 'opencode', dark: true, builtin: true, accent: '', colors: opencode.dark },
  { id: 'vesper', label: 'vesper', dark: true, accent: '#ffc799', colors: {
      background: '#101010',
      foreground: '#ffffff',
      cursor: '#ffc799',
      cursorAccent: '#101010',
      selectionBackground: '#333333',
      black: '#101010',
      red: '#ff8080',
      green: '#99ffe4',
      yellow: '#ffc799',
      blue: '#a0a0a0',
      magenta: '#ff7300',
      cyan: '#99ffe4',
      white: '#ffffff',
      brightBlack: '#505050',
      brightRed: '#ff8080',
      brightGreen: '#99ffe4',
      brightYellow: '#ffcfa8',
      brightBlue: '#a0a0a0',
      brightMagenta: '#ff8080',
      brightCyan: '#99ffe4',
      brightWhite: '#ffffff'
  } },
  { id: 'gruvbox-dark', label: 'gruvbox dark', dark: true, accent: '#fabd2f', colors: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
      brightRed: '#fb4934',
      brightGreen: '#b8bb26',
      brightYellow: '#fabd2f',
      brightBlue: '#83a598',
      brightMagenta: '#d3869b',
      brightCyan: '#8ec07c',
      brightWhite: '#ebdbb2'
  } },
  { id: 'catppuccin-mocha', label: 'catppuccin mocha', dark: true, accent: '#cba6f7', colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#585b70',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8'
  } },
  { id: 'catppuccin-latte', label: 'catppuccin latte', dark: false, accent: '#8839ef', colors: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      cursorAccent: '#eff1f5',
      selectionBackground: '#acb0be',
      black: '#5c5f77',
      red: '#d20f39',
      green: '#40a02b',
      yellow: '#df8e1d',
      blue: '#1e66f5',
      magenta: '#ea76cb',
      cyan: '#179299',
      white: '#acb0be',
      brightBlack: '#6c6f85',
      brightRed: '#d20f39',
      brightGreen: '#40a02b',
      brightYellow: '#df8e1d',
      brightBlue: '#1e66f5',
      brightMagenta: '#ea76cb',
      brightCyan: '#179299',
      brightWhite: '#bcc0cc'
  } },
  { id: 'tokyo-night', label: 'tokyo night', dark: true, accent: '#7aa2f7', colors: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
      brightRed: '#f7768e',
      brightGreen: '#9ece6a',
      brightYellow: '#e0af68',
      brightBlue: '#7aa2f7',
      brightMagenta: '#bb9af7',
      brightCyan: '#7dcfff',
      brightWhite: '#c0caf5'
  } },
  { id: 'nord', label: 'nord', dark: true, accent: '#88c0d0', colors: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
  } },
  { id: 'solarized-dark', label: 'solarized dark', dark: true, accent: '#268bd2', colors: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
  } },
  { id: 'dracula', label: 'dracula', dark: true, accent: '#bd93f9', colors: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff'
  } },
  { id: 'one-dark', label: 'one dark', dark: true, accent: '#61afef', colors: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#282c34',
      selectionBackground: '#3e4451',
      black: '#1e2127',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#d19a66',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#d19a66',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#ffffff'
  } },
  { id: 'rose-pine', label: 'rosé pine', dark: true, accent: '#c4a7e7', colors: {
      background: '#191724',
      foreground: '#e0def4',
      cursor: '#524f67',
      cursorAccent: '#191724',
      selectionBackground: '#403d52',
      black: '#26233a',
      red: '#eb6f92',
      green: '#31748f',
      yellow: '#f6c177',
      blue: '#9ccfd8',
      magenta: '#c4a7e7',
      cyan: '#ebbcba',
      white: '#e0def4',
      brightBlack: '#6e6a86',
      brightRed: '#eb6f92',
      brightGreen: '#31748f',
      brightYellow: '#f6c177',
      brightBlue: '#9ccfd8',
      brightMagenta: '#c4a7e7',
      brightCyan: '#ebbcba',
      brightWhite: '#e0def4'
  } },
  { id: 'kanagawa', label: 'kanagawa', dark: true, accent: '#7e9cd8', colors: {
      background: '#1f1f28',
      foreground: '#dcd7ba',
      cursor: '#c8c093',
      cursorAccent: '#1f1f28',
      selectionBackground: '#2d4f67',
      selectionForeground: '#c8c093',
      black: '#090618',
      red: '#c34043',
      green: '#76946a',
      yellow: '#c0a36e',
      blue: '#7e9cd8',
      magenta: '#957fb8',
      cyan: '#6a9589',
      white: '#c8c093',
      brightBlack: '#727169',
      brightRed: '#e82424',
      brightGreen: '#98bb6c',
      brightYellow: '#e6c384',
      brightBlue: '#7fb4ca',
      brightMagenta: '#938aa9',
      brightCyan: '#7aa89f',
      brightWhite: '#dcd7ba'
  } },
  { id: 'everforest', label: 'everforest', dark: true, accent: '#a7c080', colors: {
      background: '#2d353b',
      foreground: '#d3c6aa',
      cursor: '#d3c6aa',
      cursorAccent: '#2d353b',
      selectionBackground: '#543a48',
      selectionForeground: '#d3c6aa',
      black: '#475258',
      red: '#e67e80',
      green: '#a7c080',
      yellow: '#dbbc7f',
      blue: '#7fbbb3',
      magenta: '#d699b6',
      cyan: '#83c092',
      white: '#d3c6aa',
      brightBlack: '#475258',
      brightRed: '#e67e80',
      brightGreen: '#a7c080',
      brightYellow: '#dbbc7f',
      brightBlue: '#7fbbb3',
      brightMagenta: '#d699b6',
      brightCyan: '#83c092',
      brightWhite: '#d3c6aa'
  } }
]

export function findTerminalTheme(id: string): TerminalTheme | undefined {
  return TERMINAL_THEMES.find((t) => t.id === id)
}

export function terminalIsDark(id: string, appTheme: 'dark' | 'light'): boolean {
  if (id === 'auto') return appTheme === 'dark'
  return findTerminalTheme(id)?.dark ?? appTheme === 'dark'
}

export function terminalTheme(id: string, appTheme: 'dark' | 'light'): ITheme {
  if (id === 'auto') return opencode[appTheme]
  return findTerminalTheme(id)?.colors ?? opencode[appTheme]
}

// App colors built from a terminal theme. Text, borders and status colors are pushed to the same
// WCAG contrast targets as app.css: text 7, secondary 4.5, faint text and borders 3.
export function appColors(id: string): Record<string, string> | null {
  const theme = findTerminalTheme(id)
  if (!theme || theme.builtin) return null
  const c = theme.colors as Required<Pick<ITheme, 'background' | 'foreground' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'brightBlack' | 'brightWhite'>>
  const bg = c.background
  const dir = theme.dark ? 1 : -1
  const [bl, bc, bh] = toLch(bg)
  const surface = (step: number): string => fit([bl + dir * step, bc, bh])
  const steps = theme.dark ? [0.03, 0.07, 0.105, 0.35] : [0.018, 0.045, 0.09, 0.35]
  // panels and hovered rows sit on the raised surface, which has less contrast than the page
  const ref = surface(steps[0])

  const [fl, fc, fh] = toLch(c.foreground)
  const brightest = theme.dark && toLch(c.brightWhite)[0] > fl ? c.brightWhite : c.foreground
  const strong = readable(brightest, ref, 12, dir)
  const sl = toLch(strong)[0]
  const textL = dir > 0 ? Math.min(fl, sl - 0.1) : Math.max(fl, sl + 0.1)
  const text = readable([textL, fc, fh], ref, 7, dir)
  const tl = toLch(text)[0]
  const tone = (drop: number, min: number): string => readable([tl - dir * drop, fc * 0.7, fh], ref, min, dir)

  const accent = theme.accent
  const orange = mix(c.red, c.yellow, 0.5)
  const status = (color: string | Lch, min = 4.5): string => readable(color, ref, min, dir)
  const onAccent = [bg, strong, '#000000', '#ffffff'].reduce((a, b) => (contrast(b, accent) > contrast(a, accent) ? b : a))

  return {
    '--bg': bg,
    '--bg-weak': surface(steps[0]),
    '--bg-weak-hover': surface(steps[1]),
    '--bg-strong': strong,
    '--bg-strong-hover': fit([sl + dir * 0.03, toLch(strong)[1], toLch(strong)[2]]),
    '--bg-interactive': accent,
    '--bg-selected': fit(mix(bg, accent, 0.16)),
    '--bg-highlight': fit(mix(bg, accent, 0.2)),
    '--text': text,
    '--text-weak': tone(0.13, 4.5),
    '--text-weaker': tone(0.25, 3),
    '--text-strong': strong,
    '--text-inverted': bg,
    '--text-on-interactive': onAccent,
    '--border': readable([bl + dir * steps[3], bc, bh], ref, 3, dir),
    '--border-weak': surface(steps[2]),
    '--icon': tone(0.17, 3.5),
    '--focus': status(accent, 3),
    '--danger': status(c.red),
    '--success': status(c.green),
    '--warning': status(c.yellow),
    '--accent': status(accent),
    '--folder-red': status(c.red, 3),
    '--folder-orange': status(orange, 3),
    '--folder-yellow': status(c.yellow, 3),
    '--folder-green': status(c.green, 3),
    '--folder-blue': status(c.blue, 3),
    '--folder-purple': status(c.magenta, 3),
    '--syntax-keyword': status(c.magenta),
    '--syntax-string': status(c.green),
    '--syntax-number': status(orange),
    '--syntax-comment': status(c.brightBlack),
    '--syntax-function': status(c.blue),
    '--syntax-type': status(c.yellow),
    '--syntax-property': status(c.cyan),
    '--syntax-tag': status(c.red),
    '--syntax-attribute': status(orange),
    '--shadow': `0 16px 48px oklch(0 0 0 / ${theme.dark ? 0.5 : 0.12})`
  }
}
