import { promises as fs } from 'node:fs'

// temp file + fsync + rename, so a crash or power loss leaves either the old file or the new one, never half of it
export async function writeFileAtomic(path: string, data: string | Buffer, backup = false): Promise<void> {
  const tmp = `${path}.tmp`
  const handle = await fs.open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (backup) await fs.copyFile(path, `${path}.bak`).catch(() => {})
  await fs.rename(tmp, path)
}
