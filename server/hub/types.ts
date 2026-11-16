/**
 * Flovart Hub (TS port of backend/, runs as Cloudflare Pages Functions).
 *
 * Minimal structural types for the Cloudflare bindings we use, so the code
 * type-checks without pulling @cloudflare/workers-types into the whole app
 * (the root tsconfig compiles browser + node + functions together). They are a
 * strict subset of the real D1Database / R2Bucket interfaces, which is also
 * what lets tests inject an in-memory SQLite shim (tests/helpers/d1Shim.ts).
 */

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
  [key: string]: unknown;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements in one implicit transaction (all-or-nothing). */
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface R2ObjectHead {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
}

export interface R2Bucket {
  head(key: string): Promise<R2ObjectHead | null>;
  delete(key: string | string[]): Promise<void>;
}

/** Bindings + vars + secrets configured in wrangler.jsonc / the Pages dashboard. */
export interface HubEnv {
  /** D1 binding (wrangler.jsonc d1_databases[].binding = "HUB_DB"). */
  HUB_DB?: D1Database;
  /** R2 binding (wrangler.jsonc r2_buckets[].binding = "HUB_BUCKET"); used for head/delete on confirm. */
  HUB_BUCKET?: R2Bucket;
  /** Secret: HS256 signing key, ≥ 32 random bytes. `wrangler pages secret put JWT_SECRET`. */
  JWT_SECRET?: string;
  /** Token lifetime in hours (default 168, same as Go). */
  JWT_EXP_HOURS?: string;
  /** Same semantics as Go CORS_ALLOW: "*" (default) | "loopback" | "off" | comma-separated origins. */
  CORS_ALLOW?: string;
  /**
   * Presigned PUT needs S3-API credentials (an R2 API token): the R2 *binding*
   * cannot mint presigned URLs. Secrets: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
   */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  /** Bucket name for the S3 endpoint (must be the bucket bound as HUB_BUCKET). */
  R2_BUCKET?: string;
  /** Public base URL of the bucket (r2.dev or custom domain), e.g. https://assets.example.com */
  R2_PUBLIC_BASE?: string;
}
