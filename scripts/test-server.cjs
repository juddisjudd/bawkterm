// Local SSH + SFTP server for manual testing. Login: test / test (any public key is also accepted).
// Usage: node scripts/test-server.cjs [port] [rootDir]
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Server, utils } = require('ssh2')

const PORT = Number(process.argv[2] || 2222)
const ROOT = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'bawkterm-test-root'))
const KEY_FILE = path.join(os.tmpdir(), 'bawkterm-test-hostkey')
const { STATUS_CODE, OPEN_MODE } = utils.sftp

fs.mkdirSync(ROOT, { recursive: true })
if (!fs.existsSync(path.join(ROOT, 'readme.txt'))) {
  fs.writeFileSync(path.join(ROOT, 'readme.txt'), 'hello from the bawkterm test server\n')
  fs.mkdirSync(path.join(ROOT, 'projects', 'demo'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'projects', 'demo', 'notes.md'), '# demo\n')
  fs.writeFileSync(path.join(ROOT, '.hidden'), 'secret\n')
}
if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, utils.generateKeyPairSync('ed25519').private)

const toLocal = (p) => {
  const clean = path.posix.normalize('/' + (p || '.')).replace(/^\/+/, '')
  const full = path.join(ROOT, clean)
  if (!full.startsWith(ROOT)) throw new Error('outside root')
  return full
}

const attrsOf = (st) => ({
  mode: st.mode,
  uid: 1000,
  gid: 1000,
  size: st.size,
  atime: Math.floor(st.atimeMs / 1000),
  mtime: Math.floor(st.mtimeMs / 1000)
})

function longname(name, st) {
  const type = st.isDirectory() ? 'd' : '-'
  return `${type}rw-r--r-- 1 test test ${st.size} Jan 1 00:00 ${name}`
}

function startSftp(sftp) {
  const handles = new Map()
  let next = 0
  const newHandle = (value) => {
    const id = Buffer.alloc(4)
    id.writeUInt32BE(next++)
    handles.set(id.toString('hex'), value)
    return id
  }
  const get = (h) => handles.get(h.toString('hex'))
  const fail = (reqid, err) =>
    sftp.status(reqid, err && err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err && err.message)

  sftp.on('REALPATH', (reqid, p) => {
    const norm = path.posix.normalize('/' + (p === '.' ? '' : p))
    sftp.name(reqid, [{ filename: norm, longname: norm, attrs: {} }])
  })
  sftp.on('OPEN', (reqid, p, flags) => {
    try {
      let mode = 'r'
      if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.TRUNC || flags & OPEN_MODE.CREAT ? 'w' : 'r+'
      if (flags & OPEN_MODE.APPEND) mode = 'a'
      const fd = fs.openSync(toLocal(p), mode)
      sftp.handle(reqid, newHandle({ fd }))
    } catch (err) {
      fail(reqid, err)
    }
  })
  sftp.on('READ', (reqid, h, offset, length) => {
    const f = get(h)
    if (!f || f.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buf = Buffer.alloc(length)
    const n = fs.readSync(f.fd, buf, 0, length, offset)
    if (!n) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.data(reqid, buf.subarray(0, n))
  })
  sftp.on('WRITE', (reqid, h, offset, data) => {
    const f = get(h)
    if (!f || f.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
    fs.writeSync(f.fd, data, 0, data.length, offset)
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('CLOSE', (reqid, h) => {
    const f = get(h)
    if (f && f.fd !== undefined) fs.closeSync(f.fd)
    handles.delete(h.toString('hex'))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('FSTAT', (reqid, h) => {
    const f = get(h)
    if (!f || f.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
    sftp.attrs(reqid, attrsOf(fs.fstatSync(f.fd)))
  })
  const stat = (fn) => (reqid, p) => {
    try {
      sftp.attrs(reqid, attrsOf(fn(toLocal(p))))
    } catch (err) {
      fail(reqid, err)
    }
  }
  sftp.on('STAT', stat(fs.statSync))
  sftp.on('LSTAT', stat(fs.lstatSync))
  sftp.on('OPENDIR', (reqid, p) => {
    try {
      const dir = toLocal(p)
      if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory')
      sftp.handle(reqid, newHandle({ dir, done: false }))
    } catch (err) {
      fail(reqid, err)
    }
  })
  sftp.on('READDIR', (reqid, h) => {
    const d = get(h)
    if (!d || d.dir === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
    if (d.done) return sftp.status(reqid, STATUS_CODE.EOF)
    d.done = true
    const names = fs.readdirSync(d.dir).map((filename) => {
      const st = fs.lstatSync(path.join(d.dir, filename))
      return { filename, longname: longname(filename, st), attrs: attrsOf(st) }
    })
    sftp.name(reqid, names)
  })
  const simple = (fn) => (reqid, ...args) => {
    try {
      fn(...args)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch (err) {
      fail(reqid, err)
    }
  }
  sftp.on('MKDIR', simple((p) => fs.mkdirSync(toLocal(p))))
  sftp.on('RMDIR', simple((p) => fs.rmdirSync(toLocal(p))))
  sftp.on('REMOVE', simple((p) => fs.unlinkSync(toLocal(p))))
  sftp.on('RENAME', simple((a, b) => fs.renameSync(toLocal(a), toLocal(b))))
  sftp.on('SETSTAT', simple((p, attrs) => attrs.mode !== undefined && fs.chmodSync(toLocal(p), attrs.mode)))
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
}

function startShell(stream, user) {
  const prompt = () => stream.write(`\x1b[32m${user}@bawk-test\x1b[0m:\x1b[34m~\x1b[0m$ `)
  stream.write(`Welcome to the bawkterm test server.\r\nCommands: help, ls, colors, flood, whoami, date, exit\r\n`)
  prompt()
  let line = ''
  const run = (cmd) => {
    const [name, ...rest] = cmd.trim().split(/\s+/)
    switch (name) {
      case '':
        break
      case 'help':
        stream.write('help ls colors flood whoami date echo exit\r\n')
        break
      case 'ls':
        stream.write(fs.readdirSync(ROOT).join('  ') + '\r\n')
        break
      case 'whoami':
        stream.write(user + '\r\n')
        break
      case 'date':
        stream.write(new Date().toString() + '\r\n')
        break
      case 'echo':
        stream.write(rest.join(' ') + '\r\n')
        break
      case 'colors':
        for (let i = 0; i < 16; i++) stream.write(`\x1b[${i < 8 ? 30 + i : 90 + i - 8}m color${i} \x1b[0m`)
        stream.write('\r\n\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m https://opencode.ai\r\n')
        break
      case 'flood':
        for (let i = 0; i < 20000; i++) stream.write(`line ${i} ${'x'.repeat(60)}\r\n`)
        break
      case 'exit':
        stream.write('logout\r\n')
        stream.exit(0)
        stream.end()
        return
      default:
        stream.write(`${name}: command not found\r\n`)
    }
    prompt()
  }
  stream.on('data', (data) => {
    for (const ch of data.toString('utf8')) {
      if (ch === '\r') {
        stream.write('\r\n')
        const cmd = line
        line = ''
        run(cmd)
      } else if (ch === '\x7f') {
        if (line) {
          line = line.slice(0, -1)
          stream.write('\b \b')
        }
      } else if (ch === '\x03') {
        line = ''
        stream.write('^C\r\n')
        prompt()
      } else if (ch >= ' ') {
        line += ch
        stream.write(ch)
      }
    }
  })
}

new Server({ hostKeys: [fs.readFileSync(KEY_FILE)] }, (client) => {
  let user = 'test'
  client
    .on('authentication', (ctx) => {
      user = ctx.username
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') return ctx.accept()
      if (ctx.method === 'publickey') {
        if (!ctx.signature) return ctx.accept()
        const key = utils.parseKey(ctx.key.data)
        if (!(key instanceof Error) && key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept()
      }
      ctx.reject(['password', 'publickey'])
    })
    .on('ready', () => {
      console.log(`[test-server] ${user} logged in`)
      client.on('tcpip', (accept, reject, info) => {
        const sock = net.connect(info.destPort, info.destIP === 'localhost' ? '127.0.0.1' : info.destIP)
        sock.once('error', () => reject())
        sock.once('connect', () => {
          const stream = accept()
          stream.pipe(sock).pipe(stream)
        })
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (ok) => ok && ok())
        session.on('window-change', (ok) => ok && ok())
        session.on('env', (ok) => ok && ok())
        session.on('shell', (ok) => startShell(ok(), user))
        session.on('sftp', (ok) => startSftp(ok()))
      })
    })
    .on('error', (err) => console.log('[test-server] client error:', err.message))
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[test-server] listening on 127.0.0.1:${PORT}, root ${ROOT}`)
})
