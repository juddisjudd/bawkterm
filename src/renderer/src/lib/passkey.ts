import type { PasskeyEnrollment } from '@shared/types'

interface PrfOutput {
  enabled?: boolean
  results?: { first?: ArrayBuffer }
}

const random = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n))

function b64(data: ArrayBuffer | Uint8Array): string {
  let s = ''
  for (const byte of new Uint8Array(data)) s += String.fromCharCode(byte)
  return btoa(s)
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
}

function prf(credential: PublicKeyCredential): PrfOutput | undefined {
  return (credential.getClientExtensionResults() as { prf?: PrfOutput }).prf
}

function friendly(err: unknown): Error {
  const e = err as DOMException
  if (e?.name === 'NotAllowedError') return new Error('Passkey cancelled or timed out')
  if (e?.name === 'InvalidStateError') return new Error('That device already has a bawkterm passkey. Pick it when unlocking, or delete it on the device first.')
  return err instanceof Error ? err : new Error(String(err))
}

async function evaluate(e: PasskeyEnrollment): Promise<ArrayBuffer> {
  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: e.rpId,
        challenge: random(32),
        timeout: 180_000,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: unb64(e.credentialId), transports: e.transports as AuthenticatorTransport[] }],
        extensions: { prf: { eval: { first: unb64(e.salt) } } } as AuthenticationExtensionsClientInputs
      }
    })) as PublicKeyCredential | null
  } catch (err) {
    throw friendly(err)
  }
  const first = assertion && prf(assertion)?.results?.first
  if (!first) throw new Error('The passkey did not return a key. It may not support the PRF extension.')
  return first
}

export async function enrollPasskey(): Promise<{ enrollment: PasskeyEnrollment; output: string }> {
  const rpId = location.hostname
  const salt = random(32)
  let created: PublicKeyCredential | null
  try {
    created = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: 'bawkterm' },
        user: { id: random(16), name: 'bawkterm vault', displayName: 'bawkterm vault' },
        challenge: random(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        timeout: 180_000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs
      }
    })) as PublicKeyCredential | null
  } catch (err) {
    throw friendly(err)
  }
  if (!created) throw new Error('No passkey was created')
  const result = prf(created)
  if (result?.enabled === false) {
    throw new Error('That passkey cannot unlock bawkterm because it lacks the PRF extension. Try a phone passkey or a newer security key.')
  }
  const enrollment: PasskeyEnrollment = {
    credentialId: b64(created.rawId),
    salt: b64(salt),
    rpId,
    transports: (created.response as AuthenticatorAttestationResponse).getTransports?.() ?? []
  }
  const first = result?.results?.first ?? (await evaluate(enrollment))
  return { enrollment, output: b64(first) }
}

export async function passkeySecret(enrollment: PasskeyEnrollment): Promise<string> {
  if (enrollment.rpId !== location.hostname) {
    throw new Error(`This passkey was set up for ${enrollment.rpId}, but the app is running from ${location.hostname}`)
  }
  return b64(await evaluate(enrollment))
}
