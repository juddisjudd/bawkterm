import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  Client,
  type AnyAuthMethod,
  type AuthenticationType,
  type NextAuthHandler,
  type ParsedKey,
  type ServerHostKeyAlgorithm
} from 'ssh2'
import { hostKeyId } from '@shared/defaults'
import type { ConnectTarget, PromptRequest, PromptResponse, SshKey } from '@shared/types'
import { isEncryptedKeyError, parsePrivateKey, parsePublicBlob } from '../keys'
import { isPpk, ppkToOpenSsh } from '../ppk'
import { AllAgents, ForwardedAgent, agentPaths } from './agent'
import type { Vault } from '../vault'

export type Ask = (req: Omit<PromptRequest, 'id' | 'sessionId'>) => Promise<PromptResponse | null>

export interface ConnectContext {
  vault: Vault
  ask: Ask
  signal: AbortSignal
  onProgress?: (message: string) => void
}

export interface Connection {
  client: Client
  chain: Client[]
  label: string
  hostId?: string
}

interface Resolved {
  hostId?: string
  label: string
  address: string
  port: number
  username: string
  password: string
  key?: SshKey
  useAgent: boolean
  agentForward: boolean
  jumpHostId: string
}

const MAX_HOPS = 5
const SUPPORTED_HOST_KEY = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
  'ssh-dss'
]
const READY_TIMEOUT = 20_000

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

function resolveTarget(target: ConnectTarget, vault: Vault): Resolved {
  const data = vault.get()
  if ('adhoc' in target) {
    const { address, port, username } = target.adhoc
    return { label: address, address, port, username, password: '', useAgent: true, agentForward: false, jumpHostId: '' }
  }
  const host = data.hosts.find((h) => h.id === target.hostId)
  if (!host) throw new Error('Host not found in vault')
  const identity = host.identityId ? data.identities.find((i) => i.id === host.identityId) : undefined
  const keyId = host.keyId || identity?.keyId || ''
  return {
    hostId: host.id,
    label: host.label || host.address,
    address: host.address,
    port: host.port || 22,
    username: host.username || identity?.username || '',
    password: host.password || identity?.password || '',
    key: keyId ? data.keys.find((k) => k.id === keyId) : undefined,
    useAgent: host.useAgent,
    agentForward: host.agentForward,
    jumpHostId: host.jumpHostId
  }
}

function friendlyError(err: Error & { code?: string; level?: string }, r: Resolved): Error {
  const where = `${r.address}:${r.port}`
  switch (err.code) {
    case 'ECONNREFUSED':
      return new Error(`Connection refused by ${where}`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new Error(`Host not found: ${r.address}`)
    case 'ETIMEDOUT':
      return new Error(`Connection to ${where} timed out`)
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new Error(`Network unreachable: ${where}`)
    case 'ECONNRESET':
      return new Error(`Connection reset by ${where}`)
  }
  if (err.level === 'client-authentication') return new Error(`Authentication failed for ${r.username}@${where}`)
  if (/verification failed/i.test(err.message)) return new Error(`Host key for ${where} was not trusted`)
  if (err.level === 'client-timeout') return new Error(`Timed out waiting for ${where} to respond`)
  return err
}

async function verifyHostKey(key: Buffer, r: Resolved, ctx: ConnectContext): Promise<boolean> {
  const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  const keyType = parsePublicBlob(key)
  const id = hostKeyId(r.address, r.port)
  const trusted = ctx.vault.get().knownHosts.filter((k) => k.host === id)
  const known = trusted.find((k) => k.keyType === keyType)
  if (known?.fingerprint === fingerprint) return true

  // a different key type for a host we already trust is treated as a changed key, not a new host
  const answer = await ctx.ask(
    trusted.length
      ? {
          kind: 'hostkey-changed',
          title: 'Host key changed',
          message: known
            ? `The ${keyType} key for ${id} is not the one you trusted before. Someone may be intercepting this connection. Only continue if you know the server key was replaced.`
            : `${id} offered a ${keyType} key, but you trusted a different kind of key for it before. Someone may be intercepting this connection. Only continue if you know the server keys were replaced.`,
          detail: [...trusted.map((k) => `trusted   ${k.keyType} ${k.fingerprint}`), `presented ${keyType} ${fingerprint}`].join('\n'),
          fields: [],
          confirmLabel: 'Trust new key',
          danger: true
        }
      : {
          kind: 'hostkey-new',
          title: 'New host',
          message: `You have not connected to ${id} before. Check that this fingerprint matches the server.`,
          detail: `${keyType}\n${fingerprint}`,
          fields: [],
          confirmLabel: 'Trust and connect'
        }
  )
  if (!answer) return false
  await ctx.vault.mutate((d) => {
    d.knownHosts = d.knownHosts.filter((k) => k.host !== id)
    d.knownHosts.push({ host: id, keyType, fingerprint, addedAt: Date.now() })
  })
  return true
}

// like OpenSSH, ask for the key types already trusted for this host first so a server cannot steer us to another type
function hostKeyOrder(
  r: Resolved,
  ctx: ConnectContext
): Record<'remove' | 'prepend' | 'append', ServerHostKeyAlgorithm[]> | undefined {
  const id = hostKeyId(r.address, r.port)
  const algos = ctx.vault
    .get()
    .knownHosts.filter((k) => k.host === id)
    .flatMap((k) => (k.keyType === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [k.keyType]))
    .filter((a): a is ServerHostKeyAlgorithm => SUPPORTED_HOST_KEY.includes(a))
  return algos.length ? { remove: algos, prepend: algos, append: [] } : undefined
}

async function unlockKey(r: Resolved, ctx: ConnectContext): Promise<ParsedKey | null> {
  const key = r.key
  if (!key) return null
  const first = parsePrivateKey(key.privateKey, key.passphrase)
  if (!(first instanceof Error)) return first
  if (!isEncryptedKeyError(first)) throw new Error(`Key "${key.label}" is unreadable: ${first.message}`)

  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await ctx.ask({
      kind: 'passphrase',
      title: 'Key passphrase',
      message: attempt ? `Wrong passphrase. Try again for "${key.label}".` : `Enter the passphrase for "${key.label}".`,
      fields: [{ name: 'passphrase', label: 'Passphrase', secret: true }],
      confirmLabel: 'Unlock',
      checkbox: { name: 'save', label: 'Save passphrase in vault' }
    })
    if (!answer) throw new CancelledError()
    const parsed = parsePrivateKey(key.privateKey, answer.values.passphrase)
    if (parsed instanceof Error) continue
    if (answer.checked) {
      const converted = isPpk(key.privateKey) ? ppkToOpenSsh(key.privateKey, answer.values.passphrase) : null
      await ctx.vault.mutate((d) => {
        const stored = d.keys.find((k) => k.id === key.id)
        if (!stored) return
        if (typeof converted === 'string') {
          stored.privateKey = converted
          stored.encrypted = false
        } else {
          stored.passphrase = answer.values.passphrase
        }
        stored.updatedAt = Date.now()
      })
    }
    return parsed
  }
  throw new Error(`Could not unlock key "${key.label}"`)
}

interface AuthHooks {
  save: (password: string) => void
  abort: (err: Error) => void
  pause: () => void
  resume: () => void
  unlocked: (key: ParsedKey) => void
}

function makeAuthHandler(r: Resolved, ctx: ConnectContext, hooks: AuthHooks) {
  const tried = new Set<string>()
  let prompted = 0
  let kbdUsedSaved = false

  const allowed = (left: AuthenticationType[] | null, method: AuthenticationType): boolean =>
    !left || left.includes(method)

  const keyboard = (): AnyAuthMethod => ({
    type: 'keyboard-interactive',
    username: r.username,
    prompt: (name, instructions, _lang, prompts, finish) => {
      if (!prompts.length) return finish([])
      const lone = prompts.length === 1 && !prompts[0].echo && /password/i.test(prompts[0].prompt)
      if (lone && r.password && !kbdUsedSaved) {
        kbdUsedSaved = true
        return finish([r.password])
      }
      ctx
        .ask({
          kind: 'kbd-interactive',
          title: name || 'Server challenge',
          message: instructions || `${r.username}@${r.address} asks:`,
          fields: prompts.map((p, i) => ({ name: String(i), label: p.prompt.trim(), secret: !p.echo })),
          confirmLabel: 'Send'
        })
        .then((answer) => finish(answer ? prompts.map((_, i) => answer.values[String(i)] ?? '') : []))
        .catch(() => finish([]))
    }
  })

  const next = async (left: AuthenticationType[] | null): Promise<AnyAuthMethod | false> => {
    if (!tried.has('none')) {
      tried.add('none')
      return { type: 'none', username: r.username }
    }
    if (r.key && !tried.has('key') && allowed(left, 'publickey')) {
      tried.add('key')
      ctx.onProgress?.(`Trying key ${r.key.label}`)
      const key = await unlockKey(r, ctx)
      if (key) {
        hooks.unlocked(key)
        return { type: 'publickey', username: r.username, key }
      }
    }
    const agents = r.useAgent ? agentPaths() : []
    if (agents.length && !tried.has('agent') && allowed(left, 'publickey')) {
      tried.add('agent')
      ctx.onProgress?.('Trying SSH agent')
      // the agent may be waiting for a PIN or a touch, which is user think-time like a prompt
      const agent = new AllAgents(agents, {
        signing: (key) => {
          hooks.pause()
          if (key.type.startsWith('sk-')) ctx.onProgress?.('Touch your security key')
        },
        signed: hooks.resume
      })
      return { type: 'agent', username: r.username, agent }
    }
    if (r.password && !tried.has('password') && allowed(left, 'password')) {
      tried.add('password')
      return { type: 'password', username: r.username, password: r.password }
    }
    if (!tried.has('keyboard') && left?.includes('keyboard-interactive')) {
      tried.add('keyboard')
      return keyboard()
    }
    if (prompted < 3 && allowed(left, 'password')) {
      const answer = await ctx.ask({
        kind: 'credentials',
        title: 'Password',
        message: prompted ? `Access denied. Try again for ${r.username}@${r.address}.` : `Password for ${r.username}@${r.address}`,
        fields: [{ name: 'password', label: 'Password', secret: true }],
        confirmLabel: 'Connect',
        checkbox: r.hostId ? { name: 'save', label: 'Save password to host' } : undefined
      })
      if (!answer) throw new CancelledError()
      prompted++
      if (answer.checked) hooks.save(answer.values.password)
      return { type: 'password', username: r.username, password: answer.values.password }
    }
    return false
  }

  return (left: AuthenticationType[] | null, _partial: boolean, done: NextAuthHandler): void => {
    next(left).then(
      (method) => done(method as AnyAuthMethod),
      (err: Error) => hooks.abort(err)
    )
  }
}

function connectOne(r: Resolved, ctx: ConnectContext, sock?: Duplex): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    let cancelled = false
    let pendingPassword: string | undefined

    let timer: NodeJS.Timeout | undefined
    const disarm = (): void => clearTimeout(timer)
    const arm = (): void => {
      disarm()
      timer = setTimeout(() => fail(new Error(`Timed out waiting for ${r.address}:${r.port} to respond`)), READY_TIMEOUT)
    }
    // user think-time in prompts must not count toward the handshake timeout
    const local: ConnectContext = {
      ...ctx,
      ask: async (req) => {
        disarm()
        try {
          return await ctx.ask(req)
        } finally {
          if (!settled) arm()
        }
      }
    }

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      disarm()
      ctx.signal.removeEventListener('abort', onAbort)
      client.end()
      reject(cancelled ? new CancelledError() : err)
    }
    const onAbort = (): void => {
      cancelled = true
      fail(new CancelledError())
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    client.on('ready', () => {
      if (settled) return
      settled = true
      disarm()
      ctx.signal.removeEventListener('abort', onAbort)
      if (pendingPassword !== undefined && r.hostId) {
        const password = pendingPassword
        void ctx.vault.mutate((d) => {
          const host = d.hosts.find((h) => h.id === r.hostId)
          if (host) {
            host.password = password
            host.updatedAt = Date.now()
          }
        })
      }
      resolve(client)
    })
    client.on('error', (err: Error & { level?: string }) => {
      if (err.level === 'agent') ctx.onProgress?.('SSH agent unavailable, trying other methods')
      else fail(friendlyError(err, r))
    })
    client.on('close', () => fail(new Error(`Connection to ${r.address} closed during setup`)))

    const settings = ctx.vault.get().settings
    const forwarded = r.agentForward ? new ForwardedAgent(agentPaths()) : undefined
    ctx.onProgress?.(`Connecting to ${r.address}:${r.port}`)
    arm()
    client.connect({
      host: sock ? undefined : r.address,
      port: sock ? undefined : r.port,
      sock,
      username: r.username,
      readyTimeout: 0,
      keepaliveInterval: settings.keepAliveSec > 0 ? settings.keepAliveSec * 1000 : 0,
      keepaliveCountMax: 3,
      algorithms: { serverHostKey: hostKeyOrder(r, local) },
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        verifyHostKey(key, r, local).then(verify, () => verify(false))
      },
      ...(forwarded ? { agent: forwarded, agentForward: true } : {}),
      authHandler: makeAuthHandler(r, local, {
        save: (password) => (pendingPassword = password),
        abort: fail,
        pause: disarm,
        resume: () => {
          if (!settled) arm()
        },
        unlocked: (key) => {
          if (forwarded) forwarded.own = key
        }
      })
    })
  })
}

function forward(jump: Client, address: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The jump host did not open a connection to ${address}:${port}`)), READY_TIMEOUT)
    jump.forwardOut('127.0.0.1', 0, address, port, (err, stream) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(stream)
    })
  })
}

async function askUsername(r: Resolved, ctx: ConnectContext): Promise<void> {
  if (r.username) return
  const answer = await ctx.ask({
    kind: 'credentials',
    title: 'Username',
    message: `Which user should log in to ${r.address}?`,
    fields: [{ name: 'username', label: 'Username', value: 'root' }],
    confirmLabel: 'Continue'
  })
  if (!answer?.values.username) throw new CancelledError()
  r.username = answer.values.username
}

export async function connect(target: ConnectTarget, ctx: ConnectContext, seen: string[] = []): Promise<Connection> {
  const r = resolveTarget(target, ctx.vault)
  if (r.hostId) {
    if (seen.includes(r.hostId)) throw new Error('Jump host chain loops back on itself')
    if (seen.length >= MAX_HOPS) throw new Error(`Jump host chain is longer than ${MAX_HOPS} hops`)
  }
  await askUsername(r, ctx)

  let jump: Connection | undefined
  let sock: Duplex | undefined
  if (r.jumpHostId) {
    jump = await connect({ hostId: r.jumpHostId }, ctx, r.hostId ? [...seen, r.hostId] : seen)
    ctx.onProgress?.(`Tunnelling through ${jump.label}`)
    try {
      sock = await forward(jump.client, r.address, r.port)
    } catch (err) {
      closeConnection(jump)
      throw new Error(`Jump host ${jump.label} could not reach ${r.address}:${r.port}: ${(err as Error).message}`)
    }
  }

  try {
    const client = await connectOne(r, ctx, sock)
    if (r.hostId) {
      void ctx.vault.mutate((d) => {
        const host = d.hosts.find((h) => h.id === r.hostId)
        if (host) host.lastUsedAt = Date.now()
      })
    }
    return { client, chain: jump ? [...jump.chain, jump.client] : [], label: r.label, hostId: r.hostId }
  } catch (err) {
    if (jump) closeConnection(jump)
    throw err
  }
}

export function closeConnection(conn: Pick<Connection, 'client' | 'chain'>): void {
  conn.client.end()
  for (const hop of [...conn.chain].reverse()) hop.end()
}
