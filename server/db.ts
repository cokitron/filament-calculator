import {
  mkdirSync,
  readFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { NodeSqlExecutor } from '../src/db/nodeExecutor'
import { initializeSchema, ensureSettings, applyPragmas } from '../src/db/schema'
import type { SqlExecutor } from '../src/db/types'

/**
 * The server's single SQLite connection.
 *
 * This runs the identical schema and the identical repository functions as the
 * browser build — the only difference is the engine underneath the SqlExecutor
 * interface (node:sqlite here, sqlite-wasm there) and where the file lives.
 */

export interface ServerDatabase {
  executor: SqlExecutor
  path: string
  schema: { from: number; to: number }
  close(): void
}

/**
 * Locate schema.sql.
 *
 * Resolved from the working directory rather than __dirname: this module is
 * loaded both as compiled CommonJS (in the image) and as ESM (by vitest), and
 * __dirname does not exist in the latter. The Docker image sets WORKDIR /app and
 * copies the file to /app/src/db/schema.sql, which is the first candidate.
 */
function readSchemaSql(): string {
  const candidates = [
    ...(process.env.SCHEMA_SQL_PATH ? [process.env.SCHEMA_SQL_PATH] : []),
    join(process.cwd(), 'src', 'db', 'schema.sql'),
    join(process.cwd(), 'dist-server', 'src', 'db', 'schema.sql'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  throw new Error(
    `Could not find schema.sql. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Set SCHEMA_SQL_PATH, or run with the repository root as the working directory.',
  )
}

export function openDatabase(databasePath: string, schemaSql = readSchemaSql()): ServerDatabase {
  // Railway mounts the volume before the process starts, but the subdirectory
  // may not exist yet on a first deploy.
  mkdirSync(dirname(databasePath), { recursive: true })

  const executor = new NodeSqlExecutor(databasePath)

  // WAL matters here in a way it does not in the browser: a reader no longer
  // blocks the writer, so a long report query cannot stall a save. It also
  // survives an abrupt container stop better than the rollback journal, which is
  // exactly what a redeploy is.
  executor.exec('pragma journal_mode = WAL')
  // FULL would fsync on every commit; NORMAL loses at most the last commit on a
  // hard crash and is the usual choice for WAL. The volume is persistent, so the
  // realistic failure is a redeploy between commits, not disk loss.
  executor.exec('pragma synchronous = NORMAL')
  applyPragmas(executor)

  const schema = initializeSchema(executor, readSchemaSql())
  ensureSettings(executor)

  return {
    executor,
    path: databasePath,
    schema,
    close: () => executor.close(),
  }
}

/**
 * Serialise the database to a byte buffer for download.
 *
 * VACUUM INTO is used rather than reading the file directly: with WAL enabled
 * the main file can lag behind committed transactions, so a plain copy may omit
 * recent writes or capture a torn page. VACUUM INTO produces a consistent,
 * fully checkpointed database.
 */
export function exportDatabase(db: ServerDatabase): Buffer {
  const target = `${db.path}.export-${process.pid}-${Date.now()}`
  db.executor.run('vacuum into ?', [target])
  try {
    return readFileSync(target)
  } finally {
    try {
      // Best effort: a leftover export file is harmless but wastes volume space.
      unlinkSync(target)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Replace the database with an uploaded backup.
 *
 * Destructive and irreversible for the caller, so the current file is kept
 * alongside as .pre-restore: if the upload turns out to be the wrong file, the
 * previous data still exists on the volume and can be recovered by hand.
 */
export function importDatabase(
  db: ServerDatabase,
  bytes: Buffer,
  reopen: (path: string) => ServerDatabase,
): ServerDatabase {
  const header = bytes.subarray(0, 15).toString('utf8')
  if (!header.startsWith('SQLite format 3')) {
    throw new Error('That file is not a SQLite database.')
  }

  const path = db.path
  db.close()

  if (existsSync(path)) copyFileSync(path, `${path}.pre-restore`)

  // Write to a temporary file and rename, so an interrupted write cannot leave a
  // half-copied database in place of the real one.
  const staging = `${path}.incoming`
  writeFileSync(staging, bytes)
  renameSync(staging, path)

  // The WAL and shared-memory files belong to the replaced database; leaving
  // them would make SQLite try to recover them against the new file.
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(`${path}${suffix}`)
    } catch {
      /* not present, fine */
    }
  }

  return reopen(path)
}
