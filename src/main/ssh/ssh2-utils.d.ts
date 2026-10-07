// ssh2 keeps its signature encoder internal; the pinned, patched ssh2 keeps this path stable
declare module 'ssh2/lib/protocol/utils.js' {
  export function convertSignature(signature: Buffer, keyType: string): Buffer | false
}
