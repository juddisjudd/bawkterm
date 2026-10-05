import { existsSync } from 'node:fs'
import {
  BaseAgent,
  createAgent,
  type IdentityCallback,
  type ParsedKey,
  type SignCallback,
  type SigningRequestOptions
} from 'ssh2'

const OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'
const ANSWER_TIMEOUT = 5_000

export function agentPaths(): string[] {
  const paths = [process.env.SSH_AUTH_SOCK ?? '']
  if (process.platform === 'win32') {
    if (existsSync(OPENSSH_AGENT_PIPE)) paths.push(OPENSSH_AGENT_PIPE)
    paths.push('pageant')
  }
  return [...new Set(paths.filter(Boolean))]
}

function identities(agent: BaseAgent): Promise<ParsedKey[] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT)
    agent.getIdentities((err, keys) => {
      clearTimeout(timer)
      resolve(err ? null : ((keys ?? []) as ParsedKey[]))
    })
  })
}

export interface SignHooks {
  signing: (key: ParsedKey) => void
  signed: () => void
}

// a YubiKey often sits in gpg-agent or Pageant while the OpenSSH agent also runs, so every agent is asked
export class AllAgents extends BaseAgent<ParsedKey> {
  private agents: BaseAgent[]
  private owners = new Map<string, BaseAgent>()

  constructor(
    paths: string[],
    private hooks: SignHooks
  ) {
    super()
    this.agents = paths.map((p) => createAgent(p))
  }

  getIdentities(cb: IdentityCallback<ParsedKey>): void {
    void Promise.all(this.agents.map(identities)).then((lists) => {
      if (lists.every((list) => list === null)) return cb(new Error('No SSH agent answered'))
      const owners = new Map<string, BaseAgent>()
      const keys: ParsedKey[] = []
      lists.forEach((list, i) => {
        for (const key of list ?? []) {
          const id = key.getPublicSSH().toString('base64')
          if (owners.has(id)) continue
          owners.set(id, this.agents[i])
          keys.push(key)
        }
      })
      this.owners = owners
      cb(null, keys)
    })
  }

  sign(pubKey: ParsedKey, data: Buffer, options: SigningRequestOptions, cb?: SignCallback): void
  sign(pubKey: ParsedKey, data: Buffer, cb: SignCallback): void
  sign(pubKey: ParsedKey, data: Buffer, options: SigningRequestOptions | SignCallback, cb?: SignCallback): void {
    const done = typeof options === 'function' ? options : (cb ?? (() => {}))
    const agent = this.owners.get(pubKey.getPublicSSH().toString('base64'))
    if (!agent) return done(new Error('No SSH agent holds this key'))
    this.hooks.signing(pubKey)
    agent.sign(pubKey, data, typeof options === 'function' ? {} : options, (err, signature) => {
      this.hooks.signed()
      done(err, signature)
    })
  }
}
