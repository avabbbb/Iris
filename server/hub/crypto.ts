/**
 * Web Crypto helpers for the Hub: HS256 JWT and PBKDF2-SHA256 password hashes.
 * No dependencies; runs on Workers, Node ≥ 20 and browsers.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64 / base64url ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

/** Constant-time comparison of two byte arrays (length leak only). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- UUID (Go repository.IsUUID: uuid.Parse && len == 36) ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

// ---------- JWT HS256 ----------

export interface UserClaims {
  /** Token version (Go claim "ver"); bumping users.token_version revokes old tokens. */
  ver: number;
  sub: string;
  /** golang-jwt marshals a single audience as an array; we accept both on verify. */
  aud: string[] | string;
  exp?: number;
  iat?: number;
  nbf?: number;
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    if (hmacKeyCache.size > 8) hmacKeyCache.clear();
    hmacKeyCache.set(secret, key);
  }
  return key;
}

const JWT_HEADER = base64UrlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export async function signJwt(claims: UserClaims, secret: string): Promise<string> {
  const payload = base64UrlEncode(enc.encode(JSON.stringify(claims)));
  const input = `${JWT_HEADER}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(input)));
  return `${input}.${base64UrlEncode(sig)}`;
}

/**
 * Verifies an HS256 token (only HS256 is accepted, like jwt.WithValidMethods)
 * and returns its claims, or null when the signature, alg, exp or nbf fail.
 */
export async function verifyJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<UserClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(dec.decode(base64UrlDecode(parts[0])));
    if (!header || header.alg !== 'HS256') return null;
    const sig = base64UrlDecode(parts[2]);
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = JSON.parse(dec.decode(base64UrlDecode(parts[1])));
    if (!claims || typeof claims !== 'object') return null;
    if (claims.exp !== undefined && (typeof claims.exp !== 'number' || nowSec >= claims.exp)) return null;
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || nowSec < claims.nbf)) return null;
    return claims as UserClaims;
  } catch {
    return null;
  }
}

// ---------- PBKDF2-SHA256 password hashes ----------

/**
 * Iteration count. Cloudflare Workers free plan allows ~10 ms CPU per request,
 * and PBKDF2 CPU time is linear in iterations: measured ≈ 0.15 ms per 1 000
 * iterations of PBKDF2-HMAC-SHA256 (native BoringSSL/OpenSSL; 100k ≈ 15 ms,
 * 50k ≈ 7.5 ms, 20k ≈ 3 ms on a server core). 30 000 keeps a login (one hash +
 * D1 round trips + JWT sign) around 5 ms CPU, leaving headroom under the 10 ms
 * budget. This is far below OWASP's 600k recommendation; it is the trade-off for
 * the free plan. workerd also rejects > 100 000 iterations outright.
 *
 * The count is stored in every hash (`pbkdf2_sha256$<iter>$<salt>$<hash>`), and
 * login transparently re-hashes when a stored count is lower than this one, so
 * moving to the paid plan only needs this constant raised (e.g. to 100 000).
 */
export const PBKDF2_ITERATIONS = 30_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BITS = 256;
const PBKDF2_PREFIX = 'pbkdf2_sha256';

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, PBKDF2_HASH_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2(password, salt, iterations);
  return `${PBKDF2_PREFIX}$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export interface PasswordCheck {
  ok: boolean;
  /** True when the hash was made with fewer iterations than PBKDF2_ITERATIONS. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return { ok: false, needsRehash: false };
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) return { ok: false, needsRehash: false };
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = base64ToBytes(parts[2]);
    expected = base64ToBytes(parts[3]);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const actual = await pbkdf2(password, salt, iterations);
  const ok = timingSafeEqual(actual, expected);
  return { ok, needsRehash: ok && iterations < PBKDF2_ITERATIONS };
}
