// In-memory D1 stand-in for Hub tests, backed by Node's built-in SQLite (node:sqlite).
// It runs the real migrations/*.sql, so the SQL in server/hub/repository.ts is
// exercised against the same SQLite dialect D1 uses. Like D1, foreign keys are
// enforced and batch() is one all-or-nothing transaction; because node:sqlite is
// synchronous, a batch can never interleave with another request's statements,
// which models D1's per-database write serialisation.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../../server/hub/types';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

type Row = Record<string, unknown>;

function toParam(v: unknown): SQLInputValue {
  if (v === undefined) throw new TypeError('D1_TYPE_ERROR: undefined is not a supported bind value');
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SQLInputValue;
}

const returnsRows = (sql: string) => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);

class Statement implements D1PreparedStatement {
  constructor(private readonly db: DatabaseSync, readonly sql: string, private readonly params: unknown[] = []) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.db, this.sql, values);
  }

  execSync<T>(): D1Result<T> {
    const stmt = this.db.prepare(this.sql);
    const params = this.params.map(toParam);
    if (returnsRows(this.sql)) {
      const rows = stmt.all(...params) as T[];
      return { results: rows, success: true, meta: { changes: 0 } };
    }
    const info = stmt.run(...params);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async first<T = Row>(): Promise<T | null> {
    const rows = this.execSync<T>().results;
    return rows.length ? rows[0] : null;
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.execSync<T>();
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.execSync<T>();
  }
}

export interface TestD1 extends D1Database {
  raw: DatabaseSync;
  /** Make every statement fail (simulates a D1 outage). */
  setBroken(broken: boolean): void;
}

export function createTestD1(): TestD1 {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  let broken = false;
  const check = () => {
    if (broken) throw new Error('D1_ERROR: simulated outage');
  };
  return {
    raw,
    setBroken(v: boolean) { broken = v; },
    prepare(sql: string) {
      const stmt = new Statement(raw, sql);
      const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({
        bind: (...v: unknown[]) => wrap(s.bind(...v)),
        first: async <T>() => { check(); return s.first<T>(); },
        all: async <T>() => { check(); return s.all<T>(); },
        run: async <T>() => { check(); return s.run<T>(); },
        // keep access to the underlying statement for batch()
        ...({ __inner: s } as object),
      });
      return wrap(stmt);
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      check();
      raw.exec('BEGIN');
      try {
        const out = statements.map((s) => ((s as unknown as { __inner: Statement }).__inner).execSync<T>());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
