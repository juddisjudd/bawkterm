import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  label: string
  dark: boolean
  colors: ITheme
}

// xterm only accepts hex, so the bawk palettes are written in OKLCH and converted here
function oklch(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc
  ]
  const channel = (v: number): string => {
    const x = Math.min(1, Math.max(0, v))
    const srgb = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055
    return Math.round(srgb * 255).toString(16).padStart(2, '0')
  }
  return '#' + linear.map(channel).join('')
}

const bawk: Record<'dark' | 'light', ITheme> = {
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
  { id: 'auto', label: 'bawk (follows app theme)', dark: true, colors: bawk.dark },
  { id: 'bawk-dark', label: 'bawk dark', dark: true, colors: bawk.dark },
  { id: 'bawk-light', label: 'bawk light', dark: false, colors: bawk.light },
  { id: 'catppuccin-mocha', label: 'catppuccin mocha', dark: true, colors: {
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
  { id: 'catppuccin-latte', label: 'catppuccin latte', dark: false, colors: {
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
  { id: 'tokyo-night', label: 'tokyo night', dark: true, colors: {
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
  { id: 'gruvbox-dark', label: 'gruvbox dark', dark: true, colors: {
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
  { id: 'dracula', label: 'dracula', dark: true, colors: {
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
  { id: 'nord', label: 'nord', dark: true, colors: {
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
  { id: 'one-half-dark', label: 'one half dark', dark: true, colors: {
      background: '#282c34',
      foreground: '#dcdfe4',
      cursor: '#a3b3cc',
      cursorAccent: '#282c34',
      selectionBackground: '#474e5d',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdfe4',
      brightBlack: '#5d677a',
      brightRed: '#e06c75',
      brightGreen: '#98c379',
      brightYellow: '#e5c07b',
      brightBlue: '#61afef',
      brightMagenta: '#c678dd',
      brightCyan: '#56b6c2',
      brightWhite: '#dcdfe4'
  } },
  { id: 'solarized-dark', label: 'solarized dark', dark: true, colors: {
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
  { id: 'rose-pine', label: 'rosé pine', dark: true, colors: {
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
  } }
]

export function terminalIsDark(id: string, appTheme: 'dark' | 'light'): boolean {
  if (id === 'auto') return appTheme === 'dark'
  return TERMINAL_THEMES.find((t) => t.id === id)?.dark ?? appTheme === 'dark'
}

export function terminalTheme(id: string, appTheme: 'dark' | 'light'): ITheme {
  if (id === 'auto') return bawk[appTheme]
  return TERMINAL_THEMES.find((t) => t.id === id)?.colors ?? bawk[appTheme]
}
