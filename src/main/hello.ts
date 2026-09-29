import { execFile } from 'node:child_process'
import { constants, createPublicKey, verify } from 'node:crypto'
import { POWERSHELL } from './system'

// Windows Hello through WinRT KeyCredentialManager, driven by Windows PowerShell so no native module is needed.
// The key is held by Windows (TPM-backed where the PC has one); its RSA PKCS#1 v1.5 signatures are
// deterministic, so signing a fixed challenge yields a stable secret that only a successful Hello check can reproduce.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
  $asTask = ($methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
  $asTaskAction = ($methods | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }
  $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $null = [Windows.Security.Cryptography.CryptographicBuffer, Windows.Security.Cryptography, ContentType = WindowsRuntime]
  $manager = [Windows.Security.Credentials.KeyCredentialManager]
  $buffer = [Windows.Security.Cryptography.CryptographicBuffer]
  if (-not (Await ($manager::IsSupportedAsync()) ([bool]))) { Emit @{ status = 'Unsupported' }; exit }
  if ($env:BAWK_MODE -eq 'check') { Emit @{ status = 'Supported' }; exit }
  if ($env:BAWK_MODE -eq 'delete') { AwaitAction ($manager::DeleteAsync($env:BAWK_KEYNAME)); Emit @{ status = 'Success' }; exit }
  $resultType = [Windows.Security.Credentials.KeyCredentialRetrievalResult]
  if ($env:BAWK_MODE -eq 'create') {
    $res = Await ($manager::RequestCreateAsync($env:BAWK_KEYNAME, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) $resultType
  } else {
    $res = Await ($manager::OpenAsync($env:BAWK_KEYNAME)) $resultType
  }
  if ($res.Status -ne 'Success') { Emit @{ status = [string]$res.Status }; exit }
  $challenge = $buffer::DecodeFromBase64String($env:BAWK_CHALLENGE)
  $signed = Await ($res.Credential.RequestSignAsync($challenge)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
  if ($signed.Status -ne 'Success') { Emit @{ status = [string]$signed.Status }; exit }
  Emit @{
    status = 'Success'
    signature = $buffer::EncodeToBase64String($signed.Result)
    publicKey = $buffer::EncodeToBase64String($res.Credential.RetrievePublicKey())
  }
} catch {
  Emit @{ status = 'Error'; message = $_.Exception.Message }
}
`

interface HelloResult {
  status: string
  signature?: string
  publicKey?: string
  message?: string
}

const MESSAGES: Record<string, string> = {
  Unsupported: 'Windows Hello is not set up. Add a PIN, fingerprint or face in Settings → Accounts → Sign-in options.',
  UserCanceled: 'Windows Hello was cancelled',
  NotFound: 'The Windows Hello key for bawkterm is missing. Turn Windows Hello unlock off and on again in settings.',
  UserPrefersPassword: 'Windows Hello was declined',
  SecurityDeviceLocked: 'Windows Hello is locked after too many attempts. Unlock it with your PIN first.',
  UnknownError: 'Windows Hello failed'
}

function run(mode: 'check' | 'create' | 'sign' | 'delete', keyName = '', challenge = ''): Promise<HelloResult> {
  if (process.platform !== 'win32') return Promise.resolve({ status: 'Unsupported' })
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, BAWK_MODE: mode, BAWK_KEYNAME: keyName, BAWK_CHALLENGE: challenge }, windowsHide: true, timeout: 120_000 },
      (err, stdout) => {
        const line = stdout.trim().split(/\r?\n/).pop() ?? ''
        try {
          resolve(JSON.parse(line) as HelloResult)
        } catch {
          reject(new Error(err?.message || 'Windows Hello did not answer'))
        }
      }
    )
  })
}

export async function helloSupported(): Promise<boolean> {
  return (await run('check').catch(() => ({ status: 'Error' }))).status === 'Supported'
}

// a PSS signature would differ on every unlock and lock the user out of this method, so refuse it up front
function checkDeterministic(challenge: Buffer, signature: Buffer, publicKey: string | undefined): void {
  if (!publicKey) return
  let key
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  } catch {
    return
  }
  const pkcs1 = verify('sha256', challenge, { key, padding: constants.RSA_PKCS1_PADDING }, signature)
  const pss = !pkcs1 && verify('sha256', challenge, { key, padding: constants.RSA_PKCS1_PSS_PADDING }, signature)
  if (pss) throw new Error('Windows Hello on this PC signs in a way that cannot unlock the vault reliably')
}

export async function helloSign(keyName: string, challenge: Buffer, create: boolean): Promise<Buffer> {
  const res = await run(create ? 'create' : 'sign', keyName, challenge.toString('base64'))
  if (res.status !== 'Success' || !res.signature) {
    throw new Error(MESSAGES[res.status] ?? res.message ?? `Windows Hello: ${res.status}`)
  }
  const signature = Buffer.from(res.signature, 'base64')
  if (create) checkDeterministic(challenge, signature, res.publicKey)
  return signature
}

export async function helloDelete(keyName: string): Promise<void> {
  await run('delete', keyName).catch(() => {})
}
