export interface PathOps {
  join(dir: string, name: string): string
  parent(path: string): string | null
}

export const remotePath: PathOps = {
  join: (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`),
  parent: (path) => {
    if (path === '/' || !path) return null
    const trimmed = path.replace(/\/+$/, '')
    const i = trimmed.lastIndexOf('/')
    return i <= 0 ? '/' : trimmed.slice(0, i)
  }
}

const isWindows = window.api.platform === 'win32'

export const localPath: PathOps = {
  join: (dir, name) => {
    const sep = isWindows ? '\\' : '/'
    return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name
  },
  parent: (path) => {
    if (!path) return null
    if (isWindows) {
      if (/^[a-zA-Z]:\\?$/.test(path)) return ''
      const trimmed = path.replace(/\\+$/, '')
      const i = trimmed.lastIndexOf('\\')
      if (i < 0) return ''
      const up = trimmed.slice(0, i)
      return /^[a-zA-Z]:$/.test(up) ? up + '\\' : up
    }
    if (path === '/') return null
    const i = path.replace(/\/+$/, '').lastIndexOf('/')
    return i <= 0 ? '/' : path.slice(0, i)
  }
}
