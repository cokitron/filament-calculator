import { DatabaseSync } from 'node:sqlite'
import { SqlExecutor, SqlParam } from './types'

/**
 * SqlExecutor backed by Node's built-in SQLite, used only by the test suite.
 *
 * This exists so the schema and every repository query are exercised against a
 * real SQLite engine — the same engine family the browser runs via WASM —
 * without needing a browser, a Worker, or OPFS. If a CHECK constraint or a
 * query is wrong, the tests catch it here rather than at runtime in the app.
 */
export class NodeSqlExecutor implements SqlExecutor {
  private db: DatabaseSync
  private depth = 0

  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, params: SqlParam[] = []): void {
    this.db.prepare(sql).run(...(params as never[]))
  }

  all<T>(sql: string, params: SqlParam[] = []): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[]
  }

  get<T>(sql: string, params: SqlParam[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined
  }

  transaction<T>(fn: () => T): T {
    // SQLite has no nested transactions. Guard rather than emitting a BEGIN
    // that would throw at runtime, so a nested call is a clear programmer error.
    if (this.depth > 0) {
      throw new Error('SqlExecutor.transaction cannot be nested')
    }
    this.depth++
    this.db.exec('begin')
    try {
      const result = fn()
      this.db.exec('commit')
      return result
    } catch (err) {
      this.db.exec('rollback')
      throw err
    } finally {
      this.depth--
    }
  }

  close(): void {
    this.db.close()
  }
}
