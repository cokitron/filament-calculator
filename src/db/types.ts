/**
 * The minimum surface the repository layer needs from a SQLite engine.
 *
 * Two implementations exist:
 *   - sqlite-wasm inside a Worker, used by the running app (src/db/worker.ts)
 *   - node:sqlite, used by the test suite (src/db/testExecutor.ts)
 *
 * Keeping the repository written against this interface rather than against
 * either engine directly is what makes the data layer testable without a
 * browser, and what would make swapping the engine later a contained change.
 */
export interface SqlExecutor {
  /** Execute one or more statements, ignoring any result rows. */
  exec(sql: string): void

  /** Execute a single parameterised statement that returns nothing. */
  run(sql: string, params?: SqlParam[]): void

  /** Run a query and return every row. */
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[]

  /** Run a query and return the first row, or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | undefined

  /**
   * Run `fn` inside a transaction, rolling back if it throws.
   * Must not be nested — SQLite has no nested transactions, only savepoints.
   */
  transaction<T>(fn: () => T): T
}

/** Values SQLite can bind. Booleans are converted to 0/1 at the boundary. */
export type SqlParam = string | number | null | Uint8Array

/** SQLite stores booleans as integers; these helpers keep that at the edges. */
export const toDbBool = (v: boolean | undefined | null): number => (v ? 1 : 0)
export const fromDbBool = (v: unknown): boolean => v === 1 || v === true

/** Current ISO 8601 UTC timestamp, the format every *_at column expects. */
export const nowIso = (): string => new Date().toISOString()

/** Round a peso amount to centavos. Used only when freezing invoice figures. */
export const roundMoney = (n: number): number => Math.round(n * 100) / 100
