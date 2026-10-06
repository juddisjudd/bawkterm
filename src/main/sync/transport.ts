import type { SyncState } from '@shared/types'

// what a sync backend stores: the encrypted blob plus the two plain fields it needs for last-write-wins
export interface WireRecord {
  id: string
  updatedAt: number
  deleted: boolean
  blob: string
}

export interface Pulled {
  records: { id: string; blob: string }[]
  // nothing had been read before, so records that will not open mean the key is wrong
  fresh: boolean
  // the read position moved, even if no record came with it
  moved: boolean
  // stores the new read position in the same vault write as the merged items
  commit(sync: SyncState): void
}

export interface Transport {
  pull(sync: SyncState): Promise<Pulled>
  // returns the ids the backend refused because it already holds a newer copy
  push(records: WireRecord[]): Promise<string[]>
  mark(blob: string): Promise<void>
  // forgets the read position, so the next pull reads everything again
  rewind(sync: SyncState): void
  // stores whatever the push needs remembered, in the same vault write that records it as synced
  settle(sync: SyncState): void
}
