import { describe, it, expect } from 'vitest'
import {
  createSessionToken,
  verifySessionToken,
  secretsMatch,
  readCookie,
  buildSessionCookie,
  buildLogoutCookie,
  LoginRateLimiter,
  SESSION_COOKIE,
} from './auth'
import { loadConfig, ConfigError } from './config'

const SECRET = 'a'.repeat(48)

describe('secretsMatch', () => {
  it('matches identical secrets', () => {
    expect(secretsMatch('correct horse battery', 'correct horse battery')).toBe(true)
  })

  it('rejects different secrets', () => {
    expect(secretsMatch('correct horse battery', 'correct horse batterz')).toBe(false)
  })

  it('handles different lengths without throwing', () => {
    // timingSafeEqual throws on length mismatch; hashing first is what makes
    // this safe, and a thrown error here would be an auth bypass waiting to be
    // caught by a try/catch somewhere above.
    expect(secretsMatch('short', 'considerably longer secret')).toBe(false)
    expect(secretsMatch('', 'x')).toBe(false)
  })
})

describe('session tokens', () => {
  it('round-trips a valid token', () => {
    const token = createSessionToken(SECRET, 3600)
    const check = verifySessionToken(SECRET, token)
    expect(check.valid).toBe(true)
  })

  it('rejects a token signed with another secret', () => {
    const token = createSessionToken('b'.repeat(48), 3600)
    expect(verifySessionToken(SECRET, token)).toEqual({ valid: false, reason: 'bad-signature' })
  })

  it('rejects a tampered payload', () => {
    const token = createSessionToken(SECRET, 3600)
    const [, signature] = token.split('.')
    // Someone granting themselves a session far in the future.
    const forged = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')
    expect(verifySessionToken(SECRET, `${forged}.${signature}`)).toEqual({
      valid: false,
      reason: 'bad-signature',
    })
  })

  it('rejects an expired token', () => {
    const issuedAt = Date.now() - 7200 * 1000
    const token = createSessionToken(SECRET, 3600, issuedAt)
    expect(verifySessionToken(SECRET, token)).toEqual({ valid: false, reason: 'expired' })
  })

  it('accepts a token that has not quite expired', () => {
    const token = createSessionToken(SECRET, 3600, Date.now() - 3599 * 1000)
    expect(verifySessionToken(SECRET, token).valid).toBe(true)
  })

  it('rejects malformed and missing tokens', () => {
    for (const bad of [undefined, '', 'nodot', 'a.b.c', '.', 'x.']) {
      expect(verifySessionToken(SECRET, bad as string | undefined).valid).toBe(false)
    }
  })

  it('rejects an unsigned token with no signature at all', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')
    expect(verifySessionToken(SECRET, payload).valid).toBe(false)
  })
})

describe('cookies', () => {
  it('reads the session cookie out of a crowded header', () => {
    const header = `other=1; ${SESSION_COOKIE}=abc.def; last=2`
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc.def')
  })

  it('returns undefined when absent', () => {
    expect(readCookie('a=1; b=2', SESSION_COOKIE)).toBeUndefined()
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined()
  })

  it('sets the flags that make the cookie unreachable from JS and cross-site', () => {
    const cookie = buildSessionCookie('tok', { secure: true, maxAgeSeconds: 60 })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Max-Age=60')
  })

  it('omits Secure only when explicitly insecure', () => {
    expect(buildSessionCookie('tok', { secure: false, maxAgeSeconds: 60 })).not.toContain('Secure')
  })

  it('expires the cookie on logout', () => {
    expect(buildLogoutCookie({ secure: true })).toContain('Max-Age=0')
  })
})

describe('LoginRateLimiter', () => {
  it('allows attempts below the threshold', () => {
    const limiter = new LoginRateLimiter(3, 60_000, 60_000)
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    expect(limiter.retryAfterMs('ip')).toBe(0)
  })

  it('blocks once the threshold is reached', () => {
    const limiter = new LoginRateLimiter(3, 60_000, 60_000)
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    limiter.recordFailure('ip')
    expect(limiter.retryAfterMs('ip')).toBeGreaterThan(0)
  })

  it('tracks clients independently', () => {
    const limiter = new LoginRateLimiter(2, 60_000, 60_000)
    limiter.recordFailure('attacker')
    limiter.recordFailure('attacker')
    expect(limiter.retryAfterMs('attacker')).toBeGreaterThan(0)
    expect(limiter.retryAfterMs('the actual user')).toBe(0)
  })

  it('lets a blocked client back in after the block elapses', () => {
    const limiter = new LoginRateLimiter(2, 60_000, 1000)
    const t0 = Date.now()
    limiter.recordFailure('ip', t0)
    limiter.recordFailure('ip', t0)
    expect(limiter.retryAfterMs('ip', t0)).toBeGreaterThan(0)
    expect(limiter.retryAfterMs('ip', t0 + 1001)).toBe(0)
  })

  it('forgets old failures outside the window', () => {
    const limiter = new LoginRateLimiter(2, 1000, 60_000)
    const t0 = Date.now()
    limiter.recordFailure('ip', t0)
    // Second failure long after the window: treated as a fresh start, so a slow
    // trickle of typos never accumulates into a lockout.
    limiter.recordFailure('ip', t0 + 5000)
    expect(limiter.retryAfterMs('ip', t0 + 5000)).toBe(0)
  })

  it('clears the record on a successful login', () => {
    const limiter = new LoginRateLimiter(2, 60_000, 60_000)
    limiter.recordFailure('ip')
    limiter.recordSuccess('ip')
    limiter.recordFailure('ip')
    expect(limiter.retryAfterMs('ip')).toBe(0)
  })
})

describe('loadConfig fails closed', () => {
  const base = { AUTH_PASSWORD: 'una contraseña larga', SESSION_SECRET: SECRET }

  it('refuses to start with no password', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError)
    expect(() => loadConfig({ AUTH_PASSWORD: '' } as NodeJS.ProcessEnv)).toThrow(/refuses to start/)
  })

  it('refuses a short password', () => {
    expect(() => loadConfig({ ...base, AUTH_PASSWORD: 'corta' } as NodeJS.ProcessEnv)).toThrow(
      /at least 12 characters/,
    )
  })

  it('refuses an obvious password even when long enough', () => {
    expect(() => loadConfig({ ...base, AUTH_PASSWORD: 'password123' } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    )
    expect(() => loadConfig({ ...base, AUTH_PASSWORD: 'PrintDesk123' } as NodeJS.ProcessEnv)).toThrow(
      /attackers try first/,
    )
  })

  it('refuses a too-short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'tiny' } as NodeJS.ProcessEnv)).toThrow(
      /at least 32 characters/,
    )
  })

  it('generates a session secret but warns that restarts log you out', () => {
    const config = loadConfig({ AUTH_PASSWORD: base.AUTH_PASSWORD } as NodeJS.ProcessEnv)
    expect(config.sessionSecret).toHaveLength(64)
    expect(config.warnings.join(' ')).toMatch(/SESSION_SECRET is not set/)
  })

  it('defaults cookies to Secure and warns when opted out', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).secureCookies).toBe(true)
    const insecure = loadConfig({ ...base, INSECURE_COOKIES: 'true' } as NodeJS.ProcessEnv)
    expect(insecure.secureCookies).toBe(false)
    expect(insecure.warnings.join(' ')).toMatch(/plain HTTP/)
  })

  it('defaults the database to a volume path, not the ephemeral filesystem', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).databasePath).toBe('/data/printdesk.sqlite3')
  })

  it('rejects a nonsense port', () => {
    expect(() => loadConfig({ ...base, PORT: 'http' } as NodeJS.ProcessEnv)).toThrow(/valid port/)
    expect(() => loadConfig({ ...base, PORT: '99999' } as NodeJS.ProcessEnv)).toThrow(/valid port/)
    expect(() => loadConfig({ ...base, PORT: '-1' } as NodeJS.ProcessEnv)).toThrow(/valid port/)
  })

  it('treats an empty PORT as unset instead of coercing it to 0', () => {
    // Number('') is 0, which would bind to a random OS-assigned port and make
    // the service unreachable at the address Railway advertises.
    expect(loadConfig({ ...base, PORT: '  ' } as NodeJS.ProcessEnv).port).toBe(8080)
  })

  it('allows an explicit port 0 for tests that need an ephemeral port', () => {
    expect(loadConfig({ ...base, PORT: '0' } as NodeJS.ProcessEnv).port).toBe(0)
  })
})
