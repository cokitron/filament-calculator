import { createHmac, timingSafeEqual, createHash } from 'node:crypto'

/**
 * Single shared password, plus signed session cookies.
 *
 * There are no user accounts: one password lets you in, and everyone who knows
 * it sees the same data. That is a deliberate trade for a one-person shop, but
 * it means the two things below have to be right, because they are the only
 * things standing between the internet and the database.
 */

export const SESSION_COOKIE = 'pd_session'

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Hashing first is what makes this safe for differing lengths: timingSafeEqual
 * throws on length mismatch, and branching on that would itself reveal the
 * password's length. SHA-256 digests are always 32 bytes.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input as never).toString('base64url')

/**
 * Issue a session token: the expiry, plus an HMAC of it.
 *
 * The payload is signed rather than encrypted because it holds nothing secret —
 * only when it stops being valid. The signature is what prevents a client from
 * extending its own session by editing the cookie.
 */
export function createSessionToken(secret: string, ttlSeconds: number, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds
  const payload = base64url(JSON.stringify({ exp: expiresAt }))
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export type SessionCheck =
  | { valid: true; expiresAt: number }
  | { valid: false; reason: 'malformed' | 'bad-signature' | 'expired' }

/** Verify a session token's signature and expiry. */
export function verifySessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): SessionCheck {
  if (!token) return { valid: false, reason: 'malformed' }

  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'malformed' }
  const [payload, signature] = parts

  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  // Signature is checked before the payload is trusted at all, so a forged
  // payload never reaches JSON.parse with an attacker-chosen expiry.
  if (!secretsMatch(signature, expected)) return { valid: false, reason: 'bad-signature' }

  let parsed: { exp?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { valid: false, reason: 'malformed' }
  }

  const exp = parsed.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { valid: false, reason: 'malformed' }
  if (exp * 1000 <= now) return { valid: false, reason: 'expired' }

  return { valid: true, expiresAt: exp }
}

/** Read one cookie out of a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function buildSessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly', // unreadable from JavaScript, so an XSS bug cannot exfiltrate it
    'SameSite=Strict', // not sent on cross-site requests, which is CSRF cover
    `Max-Age=${opts.maxAgeSeconds}`,
  ]
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}

export function buildLogoutCookie(opts: { secure: boolean }): string {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}

/**
 * Per-client limit on password guesses.
 *
 * A single shared password is guessable given enough attempts, so the number of
 * attempts is what has to be capped. In-memory state is adequate because the
 * deployment is one instance with one SQLite file; it resets on restart, which
 * an attacker cannot trigger.
 */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; firstAt: number; blockedUntil: number }>()

  constructor(
    private readonly maxAttempts = 10,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly blockMs = 15 * 60 * 1000,
  ) {}

  /** Milliseconds the caller must wait, or 0 if it may attempt a login now. */
  retryAfterMs(key: string, now = Date.now()): number {
    const entry = this.attempts.get(key)
    if (!entry) return 0
    if (entry.blockedUntil > now) return entry.blockedUntil - now
    if (now - entry.firstAt > this.windowMs) {
      this.attempts.delete(key)
      return 0
    }
    return 0
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.attempts.get(key)
    if (!entry || now - entry.firstAt > this.windowMs) {
      this.attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 })
      return
    }
    entry.count += 1
    if (entry.count >= this.maxAttempts) {
      entry.blockedUntil = now + this.blockMs
      // Restart the window so a blocked client cannot immediately spend another
      // full allowance the moment the block expires.
      entry.firstAt = now
      entry.count = 0
    }
  }

  /** A successful login clears the record: legitimate use should not accumulate. */
  recordSuccess(key: string): void {
    this.attempts.delete(key)
  }
}
