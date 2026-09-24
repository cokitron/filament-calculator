import { randomBytes } from 'node:crypto'

/**
 * Server configuration, read from the environment once at boot.
 *
 * The overriding rule here is FAIL CLOSED. This process puts a shop's pricing,
 * customer list and job history on a public URL. A misconfiguration must stop
 * the server from starting, never silently start it without a lock on the door.
 */

/** Minimum shared-password length. */
const MIN_PASSWORD_LENGTH = 12

/**
 * Rejected outright: these are the first things tried against any login form,
 * and a shared password that a single guess defeats is the same as no password.
 */
const FORBIDDEN_PASSWORDS = new Set([
  'password',
  'password123',
  'contrasena',
  'contraseña',
  '123456789012',
  'changeme',
  'printdesk',
  'printdesk123',
  'letmein',
  'admin',
  'adminadmin',
  'qwertyuiop',
])

export interface ServerConfig {
  port: number
  /** Absolute path to the SQLite file. Must live on a mounted volume. */
  databasePath: string
  /** Directory holding the built frontend. */
  staticDir: string
  /** The shared password, as typed by the user at the login screen. */
  password: string
  /** HMAC key for session cookies. */
  sessionSecret: string
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number
  /** Set the Secure flag on cookies. Off only for plain-HTTP local testing. */
  secureCookies: boolean
  /** Warnings worth printing at boot that are not fatal. */
  warnings: string[]
}

export class ConfigError extends Error {}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value || value.trim() === '') {
    throw new ConfigError(
      `${name} is not set. The server refuses to start without it, because doing ` +
        'so would expose the database to anyone who finds the URL.',
    )
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const warnings: string[] = []

  const password = requireEnv(env, 'AUTH_PASSWORD')
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ConfigError(
      `AUTH_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters ` +
        `(got ${password.length}). It is the only thing protecting the data.`,
    )
  }
  if (FORBIDDEN_PASSWORDS.has(password.toLowerCase())) {
    throw new ConfigError(
      'AUTH_PASSWORD is one of the passwords attackers try first. Choose another.',
    )
  }

  // A stable secret keeps sessions valid across restarts and, on Railway, across
  // redeploys. Generating one is a usable fallback, not a good default: every
  // deploy would silently log the user out.
  let sessionSecret = env.SESSION_SECRET ?? ''
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex')
    warnings.push(
      'SESSION_SECRET is not set, so a random one was generated. Sessions will be ' +
        'invalidated on every restart. Set it to a long random string to avoid that.',
    )
  } else if (sessionSecret.length < 32) {
    throw new ConfigError('SESSION_SECRET must be at least 32 characters.')
  }

  // Railway mounts a volume at a path of your choosing; without one the
  // container filesystem is ephemeral and every redeploy silently discards the
  // database. Default to /data, which is what the deploy docs tell you to mount.
  const databasePath = env.DATABASE_PATH ?? '/data/printdesk.sqlite3'

  // An empty PORT is treated as unset rather than coerced: Number('') is 0,
  // which would silently bind to a random OS-assigned port in production.
  // An explicit "0" is allowed and means exactly that, which the tests rely on.
  const rawPort = (env.PORT ?? '').trim()
  const port = rawPort === '' ? 8080 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT is not a valid port number: ${JSON.stringify(env.PORT)}`)
  }

  // Cookies are Secure by default. Opting out is only for local HTTP testing and
  // is loud about itself, so it cannot quietly end up in production.
  const secureCookies = env.INSECURE_COOKIES !== 'true'
  if (!secureCookies) {
    warnings.push(
      'INSECURE_COOKIES=true — session cookies will be sent over plain HTTP. ' +
        'Only acceptable for local testing.',
    )
  }

  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30)
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds < 60) {
    throw new ConfigError('SESSION_TTL_SECONDS must be a number of seconds, at least 60.')
  }

  return {
    port,
    databasePath,
    staticDir: env.STATIC_DIR ?? '/app/public',
    password,
    sessionSecret,
    sessionTtlSeconds,
    secureCookies,
    warnings,
  }
}
