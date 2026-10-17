import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DbCell, DbChange, DbColumn, DbKey, DbPage, DbPageRequest, DbResult, DbTable } from '@shared/types'

const PREVIEW = 1000
const QUERY_ROWS = 1000
const BLANK = /^(?:\s|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))*$/

interface Shape {
  columns: DbColumn[]
  key: string[] | null
}

interface XInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

let db = new DatabaseSync(':memory:')
let journal = [1, 1]
let version = 0
let saved = 0

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`

function cell(v: unknown, full = false): DbCell {
  if (v instanceof Uint8Array) return { blob: v.length }
  if (!full && typeof v === 'string' && v.length > PREVIEW) return { text: v.slice(0, PREVIEW), length: v.length }
  return v as DbCell
}

function rowsOf(stmt: StatementSync): StatementSync {
  stmt.setReadBigInts(true)
  stmt.setReturnArrays(true)
  return stmt
}

function shape(table: string): Shape {
  const entry = db.prepare("SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(table) as
    | { type: string; wr: number }
    | undefined
  if (!entry) throw new Error(`There is no table named ${table}`)
  const info = db.prepare('SELECT * FROM pragma_table_xinfo(?)').all(table) as unknown as XInfo[]
  const columns = info
    .filter((c) => c.hidden !== 1)
    .map((c) => ({
      name: c.name,
      type: c.type,
      pk: c.pk > 0,
      notNull: !!c.notnull,
      default: c.dflt_value,
      generated: c.hidden > 1
    }))
  let key: string[] | null = null
  if (entry.type === 'table' && entry.wr) {
    key = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => q(c.name))
  } else if (entry.type === 'table') {
    const taken = new Set(info.map((c) => c.name.toLowerCase()))
    const alias = ['rowid', 'oid', '_rowid_'].find((a) => !taken.has(a))
    key = alias ? [alias] : null
  }
  return { columns, key }
}

function match(s: Shape, key: DbKey): string {
  if (!s.key || key.length !== s.key.length) throw new Error('This table cannot be edited here. Use SQL instead.')
  return s.key.map((k) => `${k} = ?`).join(' AND ')
}

function changeable(s: Shape, changes: DbChange[]): void {
  for (const { column } of changes) {
    const c = s.columns.find((x) => x.name === column)
    if (!c || c.generated) throw new Error(`The column ${column} cannot be changed`)
  }
}

function fingerprint(): string {
  const { n } = db.prepare('SELECT total_changes() AS n').get() as { n: number }
  const { schema_version } = db.prepare('PRAGMA schema_version').get() as { schema_version: number }
  return `${n}/${schema_version}`
}

// the server copy had a -wal or -journal beside it; SQLite applies it when the pair is opened from disk
function recover(file: Uint8Array, companion: { suffix: string; data: Uint8Array }, scratch: string): Uint8Array {
  mkdirSync(scratch, { recursive: true })
  const path = join(scratch, 'db')
  try {
    writeFileSync(path, file)
    writeFileSync(path + companion.suffix, companion.data)
    const disk = new DatabaseSync(path)
    try {
      disk.prepare('SELECT count(*) FROM sqlite_schema').get()
      if (companion.suffix === '-wal') disk.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      disk.close()
    }
    return readFileSync(path)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function load(
  file: Uint8Array,
  companion: { suffix: string; data: Uint8Array } | null,
  scratch: string,
  readOnly: boolean
): DbTable[] {
  const image = companion ? recover(file, companion, scratch) : file
  journal = [image[18], image[19]]
  // a deserialized database cannot use a write-ahead log, so it runs in rollback mode and the header is restored on save
  image[18] = image[19] = 1
  // a fresh connection each time: reading table info after a second deserialize on one connection crashes node:sqlite
  db.close()
  db = new DatabaseSync(':memory:')
  // the file comes from a server, so its views and triggers get no trust
  db.enableDefensive(true)
  db.exec('PRAGMA trusted_schema = OFF')
  db.deserialize(image)
  db.prepare('SELECT count(*) FROM sqlite_schema').get()
  db.exec(`PRAGMA query_only = ${readOnly ? 1 : 0}`)
  version = saved = 0
  return tables()
}

function tables(): DbTable[] {
  const list = db
    .prepare(
      "SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'view', 'virtual') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
    )
    .all() as { name: string; type: string }[]
  return list
    .map(({ name, type }): DbTable => {
      const counted = type === 'table' ? (db.prepare(`SELECT count(*) AS n FROM ${q(name)}`).get() as { n: number }).n : null
      return { name, kind: type === 'view' ? 'view' : 'table', rows: counted, editable: !!shape(name).key }
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'table' ? -1 : 1))
}

function page({ table, offset, limit, sort, filter }: DbPageRequest): DbPage {
  const s = shape(table)
  const cols = s.columns.map((c) => q(c.name))
  const params: string[] = []
  let where = ''
  if (filter) {
    const like = `%${filter.replace(/[\\%_]/g, '\\$&')}%`
    where = ` WHERE ${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}`
    params.push(...cols.map(() => like))
  }
  const order: string[] = []
  if (sort) {
    if (!s.columns.some((c) => c.name === sort.column)) throw new Error(`There is no column named ${sort.column}`)
    order.push(`${q(sort.column)} ${sort.desc ? 'DESC' : 'ASC'}`)
  }
  if (s.key) order.push(...s.key)
  const from = `FROM ${q(table)}${where}`
  const { n } = db.prepare(`SELECT count(*) AS n ${from}`).get(...params) as { n: number }
  const keys = s.key ?? []
  const stmt = rowsOf(
    db.prepare(`SELECT ${[...keys, ...cols].join(', ')} ${from}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ? OFFSET ?`)
  )
  const rows = (stmt.all(...params, limit, offset) as unknown as unknown[][]).map((r) => ({
    key: s.key ? (r.slice(0, keys.length) as DbKey) : null,
    cells: r.slice(keys.length).map((v) => cell(v))
  }))
  return { columns: s.columns, rows, total: n, editable: !!s.key }
}

function row(table: string, key: DbKey): DbCell[] {
  const s = shape(table)
  const stmt = rowsOf(db.prepare(`SELECT ${s.columns.map((c) => q(c.name)).join(', ')} FROM ${q(table)} WHERE ${match(s, key)}`))
  const found = stmt.get(...key) as unknown[] | undefined
  if (!found) throw new Error('This row is gone. Reload the table.')
  return found.map((v) => cell(v, true))
}

function update(table: string, key: DbKey, changes: DbChange[]): boolean {
  const s = shape(table)
  changeable(s, changes)
  if (changes.length) {
    const sets = changes.map((c) => `${q(c.column)} = ?`).join(', ')
    const res = db.prepare(`UPDATE ${q(table)} SET ${sets} WHERE ${match(s, key)}`).run(...changes.map((c) => c.value), ...key)
    if (!res.changes) throw new Error('This row is gone. Reload the table.')
    version++
  }
  return version !== saved
}

function insert(table: string, changes: DbChange[]): boolean {
  const s = shape(table)
  changeable(s, changes)
  const sql = changes.length
    ? `INSERT INTO ${q(table)} (${changes.map((c) => q(c.column)).join(', ')}) VALUES (${changes.map(() => '?').join(', ')})`
    : `INSERT INTO ${q(table)} DEFAULT VALUES`
  db.prepare(sql).run(...changes.map((c) => c.value))
  version++
  return true
}

function remove(table: string, keys: DbKey[]): boolean {
  const s = shape(table)
  const stmt = db.prepare(`DELETE FROM ${q(table)} WHERE ${match(s, keys[0] ?? [])}`)
  // a savepoint, since the SQL console may already have a transaction open
  db.exec('SAVEPOINT bawkterm_remove')
  try {
    for (const key of keys) stmt.run(...key)
    db.exec('RELEASE bawkterm_remove')
  } catch (err) {
    db.exec('ROLLBACK TO bawkterm_remove; RELEASE bawkterm_remove')
    throw err
  }
  version++
  return true
}

function collect(stmt: StatementSync): Pick<DbResult, 'columns' | 'rows' | 'more'> {
  const columns = stmt.columns().map((c) => c.name)
  const rows: DbCell[][] = []
  for (const r of rowsOf(stmt).iterate()) {
    if (rows.length === QUERY_ROWS) return { columns, rows, more: true }
    rows.push((r as unknown as unknown[]).map((v) => cell(v)))
  }
  return { columns, rows, more: false }
}

function query(sql: string): DbResult {
  const before = fingerprint()
  const { n: start } = db.prepare('SELECT total_changes() AS n').get() as { n: number }
  let result: Pick<DbResult, 'columns' | 'rows' | 'more'> = { columns: [], rows: [], more: false }
  let statements = 0
  let wrote = false
  let error: string | null = null
  try {
    for (let rest = sql; !BLANK.test(rest); ) {
      statements++
      const stmt = db.prepare(rest)
      const source = stmt.sourceSQL
      if (!rest.startsWith(source)) throw new Error('It could not be separated from the next statement. Run it on its own.')
      rest = rest.slice(source.length)
      if (stmt.columns().length) result = collect(stmt)
      else {
        wrote = true
        stmt.run()
      }
    }
  } catch (err) {
    const message = (err as Error).message || String(err)
    error = statements > 1 ? `Statement ${statements}: ${message}` : message
  }
  // statements without results (DDL, pragmas, writes) count as changes, so nothing edited here is lost unsaved
  if (wrote || fingerprint() !== before) version++
  const { n: end } = db.prepare('SELECT total_changes() AS n').get() as { n: number }
  return { ...result, statements, changes: end - start, dirty: version !== saved, error }
}

function image(): { bytes: Uint8Array; version: number } {
  if (db.isTransaction) throw new Error('A transaction is still open. Run COMMIT or ROLLBACK in the SQL tab first.')
  const bytes = db.serialize()
  bytes[18] = journal[0]
  bytes[19] = journal[1]
  return { bytes, version }
}

function markSaved(at: number): boolean {
  saved = at
  return version !== saved
}

const ops = { load, tables, page, row, update, insert, remove, query, image, markSaved }
export type DbOps = typeof ops

process.parentPort?.on('message', ({ data }) => {
  const { id, op, args } = data as { id: number; op: keyof DbOps; args: unknown[] }
  try {
    const value = (ops[op] as (...a: unknown[]) => unknown)(...args)
    process.parentPort.postMessage({ id, value })
  } catch (err) {
    process.parentPort.postMessage({ id, error: (err as Error).message || String(err) })
  }
})
