import { execFile } from 'node:child_process'

// Windows Hello through WinRT KeyCredentialManager, driven by Windows PowerShell so no native module is needed.
// The key lives in the TPM; its RSA PKCS#1 v1.5 signatures are deterministic, so signing a fixed
// challenge yields a stable secret that only a successful Hello check can reproduce.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $null = [Windows.Security.Cryptography.CryptographicBuffer, Windows.Security.Cryptography, ContentType = WindowsRuntime]
  $manager = [Windows.Security.Credentials.KeyCredentialManager]
  if (-not (Await ($manager::IsSupportedAsync()) ([bool]))) { Emit @{ status = 'Unsupported' }; exit }
  if ($env:BAWK_MODE -eq 'check') { Emit @{ status = 'Supported' }; exit }
  $resultType = [Windows.Security.Credentials.KeyCredentialRetrievalResult]
  if ($env:BAWK_MODE -eq 'create') {
    $res = Await ($manager::RequestCreateAsync('bawkterm-vault', [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) $resultType
  } else {
    $res = Await ($manager::OpenAsync('bawkterm-vault')) $resultType
  }
  if ($res.Status -ne 'Success') { Emit @{ status = [string]$res.Status }; exit }
  $challenge = [Windows.Security.Cryptography.CryptographicBuffer]::DecodeFromBase64String($env:BAWK_CHALLENGE)
  $signed = Await ($res.Credential.RequestSignAsync($challenge)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
  if ($signed.Status -ne 'Success') { Emit @{ status = [string]$signed.Status }; exit }
  Emit @{ status = 'Success'; signature = [Windows.Security.Cryptography.CryptographicBuffer]::EncodeToBase64String($signed.Result) }
} catch {
  Emit @{ status = 'Error'; message = $_.Exception.Message }
}
`

interface HelloResult {
  status: string
  signature?: string
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

function run(mode: 'check' | 'create' | 'sign', challenge = ''): Promise<HelloResult> {
  if (process.platform !== 'win32') return Promise.resolve({ status: 'Unsupported' })
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { env: { ...process.env, BAWK_MODE: mode, BAWK_CHALLENGE: challenge }, windowsHide: true, timeout: 120_000 },
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

export async function helloSign(challenge: Buffer, create: boolean): Promise<Buffer> {
  const res = await run(create ? 'create' : 'sign', challenge.toString('base64'))
  if (res.status !== 'Success' || !res.signature) {
    throw new Error(MESSAGES[res.status] ?? res.message ?? `Windows Hello: ${res.status}`)
  }
  return Buffer.from(res.signature, 'base64')
}
