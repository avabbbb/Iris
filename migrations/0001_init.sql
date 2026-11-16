-- Flovart Hub schema for Cloudflare D1 (SQLite), ported from backend/model/model.go.
-- Apply with: npx wrangler d1 migrations apply flovart-hub --remote   (see docs/deploy-cloudflare-hub.md)
--
-- Postgres → SQLite mapping:
--   uuid (gen_random_uuid)  → TEXT, generated in the Function with crypto.randomUUID() (lowercase)
--   text[] tags             → TEXT holding a JSON array ('[]'); filtered with json_each()
--   timestamptz             → TEXT, ISO-8601 UTC from Date.toISOString() (sorts lexicographically)
--   size:N varchar limits   → enforced in the service layer (same limits as Go), not by the column
-- D1 enforces FOREIGN KEY constraints by default.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY NOT NULL,
  username      TEXT NOT NULL,
  email         TEXT NOT NULL,
  password      TEXT NOT NULL,              -- pbkdf2_sha256$<iter>$<salt b64>$<hash b64>
  bio           TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',   -- user | admin
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended | deleted
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

CREATE TABLE IF NOT EXISTS prompt_packs (
  id             TEXT PRIMARY KEY NOT NULL,
  slug           TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  author_id      TEXT NOT NULL REFERENCES users (id),
  mode           TEXT NOT NULL DEFAULT '',       -- image | video | text
  tags           TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
  like_count     INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_packs_slug ON prompt_packs (slug);
CREATE INDEX IF NOT EXISTS idx_prompt_packs_title ON prompt_packs (title);
CREATE INDEX IF NOT EXISTS idx_prompt_packs_author_id ON prompt_packs (author_id);
CREATE INDEX IF NOT EXISTS idx_prompt_packs_mode ON prompt_packs (mode);
CREATE INDEX IF NOT EXISTS idx_prompt_packs_like_count ON prompt_packs (like_count);
-- List default order (latest): created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_prompt_packs_created ON prompt_packs (created_at, id);

CREATE TABLE IF NOT EXISTS prompt_items (
  id      TEXT PRIMARY KEY NOT NULL,
  pack_id TEXT NOT NULL REFERENCES prompt_packs (id),
  name    TEXT NOT NULL,
  prompt  TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prompt_items_pack_id ON prompt_items (pack_id, sort, id);

CREATE TABLE IF NOT EXISTS prompt_likes (
  user_id    TEXT NOT NULL REFERENCES users (id),
  pack_id    TEXT NOT NULL REFERENCES prompt_packs (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pack_id)
);
-- like_count is recomputed from this index after every toggle
CREATE INDEX IF NOT EXISTS idx_prompt_likes_pack_id ON prompt_likes (pack_id);
