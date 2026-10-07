type Source = 'osc7' | 'title'

// kitty sends its own scheme; both carry the folder percent-encoded
const OSC7 = /^(?:file|kitty-shell-cwd):\/\/([^/]*)(\/.*)$/
// the window title Debian, Ubuntu, Fedora, Arch and oh-my-zsh set at each prompt: user@host: ~/dir
const TITLE = /^([\w.-]+)@([\w.-]+):\s?(~(?=\/|$).*|\/.*)$/

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// a path starting with ~ means the login user's home, which only the SFTP session knows
export function resolveCwd(cwd: string, home: string): string {
  if (cwd !== '~' && !cwd.startsWith('~/')) return cwd
  return (home.replace(/\/+$/, '') + cwd.slice(1)) || '/'
}

export class CwdTracker {
  private hosts = new Map<Source, string>()
  private user = ''
  private exact = false

  reset(): void {
    this.hosts.clear()
    this.user = ''
    this.exact = false
  }

  osc7(data: string): string | null {
    const m = OSC7.exec(data.trim())
    if (!m || !this.sameHost('osc7', m[1])) return null
    this.exact = true
    return decode(m[2])
  }

  title(text: string): string | null {
    if (this.exact) return null
    const m = TITLE.exec(text.trim())
    if (!m || !this.sameHost('title', m[2])) return null
    const [, user, , path] = m
    this.user ||= user
    if (!path.startsWith('~') || user === this.user) return path
    return user === 'root' ? '/root' + path.slice(1) : null
  }

  // the first report comes from the login shell; one from another host means the user went on with ssh
  private sameHost(source: Source, host: string): boolean {
    const name = host.toLowerCase()
    const first = this.hosts.get(source)
    if (first === undefined) this.hosts.set(source, name)
    return first === undefined || first === name
  }
}
