import schemaSql from './schema.sql?raw'
import { SqlExecutor, nowIso } from './types'

/**
 * Bump this when schema.sql changes in a way an existing database must adopt.
 * Adding a new CREATE TABLE IF NOT EXISTS is safe to apply by re-running the
 * schema; altering an existing table needs an entry in MIGRATIONS below.
 */
export const SCHEMA_VERSION = 1

/**
 * Incremental upgrades from one version to the next, keyed by the version they
 * produce. Version 1 is the base schema itself, so it has no entry.
 *
 * Deliberately not auto-generated: a personal database holds the only copy of
 * real pricing history, and every structural change to it should be explicit
 * and reviewed.
 */
const MIGRATIONS: Record<number, (db: SqlExecutor) => void> = {
  // 2: db => db.exec('alter table jobs add column ...'),
}

/**
 * Prepare a connection and bring the database up to SCHEMA_VERSION.
 *
 * Safe to call on every startup: the schema uses CREATE ... IF NOT EXISTS
 * throughout, and already-applied migrations are skipped.
 */
export function initializeSchema(db: SqlExecutor): { from: number; to: number } {
  applyPragmas(db)

  const before = readVersion(db)

  if (before === 0) {
    // Fresh database. The whole schema goes on in one transaction so a failure
    // part-way through cannot leave a half-built file behind.
    db.transaction(() => {
      db.exec(schemaSql)
      db.run('insert into schema_version (version, applied_at) values (?, ?)', [
        SCHEMA_VERSION,
        nowIso(),
      ])
    })
    return { from: 0, to: SCHEMA_VERSION }
  }

  if (before > SCHEMA_VERSION) {
    // The file was written by a newer build. Upgrading the app is the fix;
    // proceeding would risk writing rows the newer schema cannot read back.
    throw new Error(
      `Database schema v${before} is newer than this app supports (v${SCHEMA_VERSION}). Update the app.`,
    )
  }

  for (let v = before + 1; v <= SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v]
    if (!migrate) continue
    db.transaction(() => {
      migrate(db)
      db.run('insert into schema_version (version, applied_at) values (?, ?)', [v, nowIso()])
    })
  }

  return { from: before, to: SCHEMA_VERSION }
}

/**
 * Connection-level settings. These are NOT stored in the file and must be
 * re-issued on every connection.
 */
export function applyPragmas(db: SqlExecutor): void {
  // SQLite ships with foreign keys DISABLED. Without this the ON DELETE CASCADE
  // clauses in schema.sql silently do nothing and orphan rows accumulate.
  db.exec('pragma foreign_keys = ON')
  // Fail fast instead of hanging if a second tab holds the database.
  db.exec('pragma busy_timeout = 5000')
}

/** Current schema version, or 0 if the database has never been initialised. */
export function readVersion(db: SqlExecutor): number {
  const tableExists = db.get<{ n: number }>(
    "select count(*) as n from sqlite_master where type = 'table' and name = 'schema_version'",
  )
  if (!tableExists || tableExists.n === 0) return 0

  const row = db.get<{ version: number }>('select max(version) as version from schema_version')
  return row?.version ?? 0
}

/** Insert the single settings row if it is missing. */
export function ensureSettings(db: SqlExecutor): void {
  const existing = db.get<{ n: number }>('select count(*) as n from settings')
  if (existing && existing.n > 0) return

  const ts = nowIso()
  db.run('insert into settings (id, created_at, updated_at) values (1, ?, ?)', [ts, ts])
}
