/**
 * Postgres database layer for voiceVault.
 *
 * Replaces better-sqlite3 with `pg`. To minimize churn across the call sites that were
 * written against the better-sqlite3 surface, we expose a thin **async adapter** with the
 * same shape:
 *
 *   const stmt = db.prepare(sql);
 *   const row  = await stmt.get(...args);
 *   const rows = await stmt.all(...args);
 *   const result = await stmt.run(...args); // { changes, lastInsertRowid: null }
 *   await db.exec(`...; ...`);              // run multi-statement DDL
 *   await db.tx(async (txDb) => { ... });   // wraps BEGIN/COMMIT/ROLLBACK
 *
 * Differences from better-sqlite3 callers should be aware of:
 *   1. All terminal methods (.get / .all / .run / db.exec / db.tx) are **async**.
 *   2. Inside a transaction callback, use the `txDb` parameter for queries that must run
 *      on the same connection (so they share the BEGIN). Calling the outer `db` works too,
 *      but those will use a separate connection and will not be part of the txn.
 *   3. `lastInsertRowid` is always `null` — the schema uses TEXT primary keys (nanoid).
 *   4. SQLite `?` and `@name` placeholders are auto-translated to Postgres `$N`.
 *      `?` consumes positional args left-to-right; `@name` looks up keys on the first
 *      argument when it's a plain object.
 *
 * Schema notes vs. the original SQLite schema:
 *   - Booleans: INTEGER (0/1) is preserved to match call sites (e.g. `is_favorite`, `paused`).
 *   - Timestamps: TEXT ISO-8601 strings to match the rest of the codebase.
 *   - BLOB columns -> BYTEA. `pg` returns Buffer for BYTEA, same as better-sqlite3.
 *   - FTS5 (notes_fts virtual table + triggers) is replaced with a generated `notes.tsv`
 *     tsvector column + a GIN index. Searches use `tsv @@ to_tsquery(...)` and ranking
 *     uses `ts_rank_cd`. The conversion of `foo* bar*` -> `foo:* & bar:*` happens in
 *     `convertSqliteFtsToPostgresTsquery()` (used by the search route).
 */

import './load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

const { Pool, types } = pg;

// pg returns int8 (BIGINT) as a JS string by default to avoid precision loss. The schema
// uses INTEGER (int4) almost everywhere, but for safety override BIGINT parsing too so
// callers that do `Number(row.audio_bytes)` keep working with either column type.
types.setTypeParser(20 /* int8 */, (val) => (val == null ? null : Number(val)));
// numeric/decimal -> Number (none of our columns are NUMERIC, but keep parity)
types.setTypeParser(1700, (val) => (val == null ? null : Number(val)));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = process.env.VV_DATA_DIR ? path.resolve(process.env.VV_DATA_DIR) : path.resolve(repoRoot, 'data');
const audioDir = path.join(dataDir, 'audio');
const blobsDir = path.join(dataDir, 'blobs');

export function ensureDataDirs() {
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(blobsDir, { recursive: true });
}

export function getPaths() {
  // `dbPath` is kept for backwards compatibility with /api/debug/paths.
  return { dataDir, audioDir, blobsDir, dbPath: '' };
}

/* ---------------------------------------------------------------------------
 * Placeholder translation
 *
 * SQLite call sites use `?` and `@name`. Postgres only supports `$1, $2, ...`.
 * `translateSql(sql, params)` walks the SQL once, copies through string literals
 * and SQL comments untouched, replaces each `?` with `$N` and each `@name` with
 * `$N`, and returns both the rewritten SQL and the resolved positional values
 * in the order Postgres needs them.
 *
 * `params` mirrors better-sqlite3's call shape:
 *   - For `?` placeholders, callers pass values as positional args.
 *   - For `@name` placeholders, callers pass a single object as the first arg.
 *   - Mixed usage is unusual but is supported by treating non-object args as
 *     positional `?` values and an object arg as the named-binding map.
 * ------------------------------------------------------------------------- */

function translateSql(sql, callArgs) {
  const text = (sql ?? '').toString();
  const len = text.length;

  // Separate the named bag (single object) from positional args.
  let namedBag = null;
  const positional = [];
  for (const a of callArgs ?? []) {
    if (
      a !== null &&
      typeof a === 'object' &&
      !Array.isArray(a) &&
      !Buffer.isBuffer(a) &&
      !(a instanceof Date)
    ) {
      // First plain object is treated as the named-binding bag. Subsequent ones
      // would be unusual; fall through and stringify.
      if (namedBag == null) {
        namedBag = a;
        continue;
      }
    }
    positional.push(a);
  }

  let out = '';
  const values = [];
  let posIdx = 0;
  let i = 0;

  while (i < len) {
    const ch = text[i];

    // Pass through single-line comments
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? len : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    // Pass through block comments
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    // Pass through single-quoted string literals (with '' escape)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }

    // Pass through double-quoted identifiers
    if (ch === '"') {
      let j = i + 1;
      while (j < len && text[j] !== '"') j += 1;
      out += text.slice(i, Math.min(j + 1, len));
      i = Math.min(j + 1, len);
      continue;
    }

    // Positional placeholder
    if (ch === '?') {
      const v = positional[posIdx];
      posIdx += 1;
      values.push(normalizeBindValue(v));
      out += `$${values.length}`;
      i += 1;
      continue;
    }

    // Named placeholder @ident
    if (ch === '@') {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      if (j > i + 1) {
        const name = text.slice(i + 1, j);
        if (namedBag == null || !(name in namedBag)) {
          throw new Error(`Missing named bind value for @${name}`);
        }
        values.push(normalizeBindValue(namedBag[name]));
        out += `$${values.length}`;
        i = j;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return { sql: out, values };
}

function normalizeBindValue(v) {
  if (v === undefined) return null;
  // pg accepts Buffer for BYTEA, Date for TIMESTAMP, string/number/boolean/null directly.
  return v;
}

/* ---------------------------------------------------------------------------
 * Adapter
 * ------------------------------------------------------------------------- */

function makeAdapter(executor) {
  // `executor` is either the pool or a transaction client. It must have:
  //   - query(sql, values) -> Promise<{ rows, rowCount }>
  // Multi-statement exec is only supported on the pool; tx callers should issue
  // statements one at a time anyway (executor.query also accepts that).

  function prepare(sql) {
    return {
      get: async (...args) => {
        const { sql: pgSql, values } = translateSql(sql, args);
        const r = await executor.query(pgSql, values);
        return r.rows[0];
      },
      all: async (...args) => {
        const { sql: pgSql, values } = translateSql(sql, args);
        const r = await executor.query(pgSql, values);
        return r.rows;
      },
      run: async (...args) => {
        const { sql: pgSql, values } = translateSql(sql, args);
        const r = await executor.query(pgSql, values);
        return { changes: r.rowCount ?? 0, lastInsertRowid: null };
      }
    };
  }

  async function exec(sql) {
    // Mirror SQLite's `db.exec()`, which runs a multi-statement script. pg supports
    // multi-statement queries when no values are passed.
    if (!(sql ?? '').toString().trim()) return;
    await executor.query(sql);
  }

  return {
    prepare,
    exec,
    raw: executor,
    // pragma is a no-op on Postgres; harmless if anything still calls it.
    pragma: async () => undefined
  };
}

/* ---------------------------------------------------------------------------
 * openDb()
 * ------------------------------------------------------------------------- */

let _pool = null;

function buildPool() {
  if (_pool) return _pool;
  const connStr = (process.env.DATABASE_URL ?? '').toString().trim();
  if (!connStr) {
    throw new Error(
      'DATABASE_URL is not set. Add it to .env (External URL for local dev, Internal URL on Render).'
    );
  }
  // Render Postgres requires SSL. Self-signed-acceptable since traffic is over Render's
  // managed network and the CA chain isn't always installed on dev machines.
  const useSsl = /render\.com/i.test(connStr) || /\bsslmode=require\b/i.test(connStr);
  _pool = new Pool({
    connectionString: connStr,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: Number.parseInt((process.env.PG_POOL_MAX ?? '').toString(), 10) || 10,
    idleTimeoutMillis: 30_000
  });
  _pool.on('error', (err) => {
    // Don't crash the process on transient pool errors.
    // eslint-disable-next-line no-console
    console.warn('[pg pool error]', err?.message ?? err);
  });
  return _pool;
}

export async function openDb() {
  ensureDataDirs();
  const pool = buildPool();

  // Fail fast if we can't connect.
  await pool.query('SELECT 1');

  await migrate(pool);

  const baseAdapter = makeAdapter(pool);

  // Mounted on the returned db so callers can do `await db.tx(async (txDb) => { ... })`
  baseAdapter.tx = async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txDb = makeAdapter(client);
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failures; the original error still bubbles
      }
      throw e;
    } finally {
      client.release();
    }
  };

  // Back-compat: a few legacy paths call `db.transaction(syncFn)` and then `tx()`.
  // We expose a wrapper that returns an async function which runs the body inside `tx`.
  // Inside `syncFn`, callers must already have been ported to use `await`, but they
  // may still reference the outer `db` (which here is the pool-bound adapter, not the
  // transaction client). For correctness, we recommend migrating to `db.tx()` directly.
  baseAdapter.transaction = function transaction(fn) {
    return async (...args) =>
      baseAdapter.tx(async () => {
        return fn.apply(null, args);
      });
  };

  return baseAdapter;
}

/* ---------------------------------------------------------------------------
 * Schema
 * ------------------------------------------------------------------------- */

const NOW_ISO_DEFAULT = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function migrate(pool) {
  // All DDL is idempotent: `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
  // Run as a single multi-statement script; pg accepts that when no values are passed.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT NOT NULL,
      password_hash   TEXT NOT NULL,
      display_name    TEXT NOT NULL DEFAULT '',
      avatar_blob_id  TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at      TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS notes (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL DEFAULT '',
      title           TEXT NOT NULL,
      display_title   TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL,
      segments_json   TEXT NOT NULL DEFAULT '',
      audio_filename  TEXT NOT NULL,
      audio_blob_id   TEXT NOT NULL DEFAULT '',
      audio_mime      TEXT NOT NULL,
      audio_bytes     INTEGER NOT NULL,
      audio_blob      BYTEA NOT NULL DEFAULT '\\x'::bytea,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      language        TEXT NOT NULL DEFAULT '',
      stt_provider    TEXT NOT NULL DEFAULT 'whisper',
      transcribe_mode TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      status          TEXT NOT NULL DEFAULT 'processing',
      error           TEXT NOT NULL DEFAULT '',
      folder_id       TEXT NOT NULL DEFAULT '',
      is_favorite     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_notes_user_created_at ON notes(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notes_user_folder_id  ON notes(user_id, folder_id);
    CREATE INDEX IF NOT EXISTS idx_notes_user_favorite   ON notes(user_id, is_favorite);
    CREATE INDEX IF NOT EXISTS idx_notes_folder_id       ON notes(folder_id);
    CREATE INDEX IF NOT EXISTS idx_notes_is_favorite     ON notes(is_favorite);

    CREATE TABLE IF NOT EXISTS note_segments (
      note_id     TEXT NOT NULL,
      seg_idx     INTEGER NOT NULL,
      start_sec   DOUBLE PRECISION NOT NULL DEFAULT 0,
      end_sec     DOUBLE PRECISION NOT NULL DEFAULT 0,
      text        TEXT NOT NULL DEFAULT '',
      words_json  TEXT NOT NULL DEFAULT '',
      embedding   BYTEA,
      embed_model TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at  TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      PRIMARY KEY (note_id, seg_idx)
    );

    CREATE INDEX IF NOT EXISTS idx_note_segments_note_id    ON note_segments(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_segments_updated_at ON note_segments(updated_at);

    CREATE TABLE IF NOT EXISTS note_chunks (
      note_id        TEXT NOT NULL,
      chunk_idx      INTEGER NOT NULL,
      start_sec      DOUBLE PRECISION NOT NULL DEFAULT 0,
      end_sec        DOUBLE PRECISION NOT NULL DEFAULT 0,
      text           TEXT NOT NULL DEFAULT '',
      seg_start_idx  INTEGER NOT NULL DEFAULT 0,
      seg_end_idx    INTEGER NOT NULL DEFAULT 0,
      embedding      BYTEA,
      embed_model    TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at     TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      PRIMARY KEY (note_id, chunk_idx)
    );

    CREATE INDEX IF NOT EXISTS idx_note_chunks_note_id    ON note_chunks(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_chunks_updated_at ON note_chunks(updated_at);

    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id            TEXT PRIMARY KEY,
      job_type      TEXT NOT NULL,
      note_id       TEXT NOT NULL,
      user_id       TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'queued',
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      locked_at     TEXT NOT NULL DEFAULT '',
      available_at  TEXT NOT NULL DEFAULT '',
      priority      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT NOT NULL DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at    TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );

    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status        ON ingestion_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_note_id       ON ingestion_jobs(note_id);
    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_ready         ON ingestion_jobs(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_ready_priority ON ingestion_jobs(status, priority, available_at, created_at);

    CREATE TABLE IF NOT EXISTS app_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );

    CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_user_name ON folders(user_id, name);

    CREATE TABLE IF NOT EXISTS tags (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, name);

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id    TEXT NOT NULL,
      tag_id     TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      PRIMARY KEY (note_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id  ON note_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_note_tags_note_id ON note_tags(note_id);

    CREATE TABLE IF NOT EXISTS saved_searches (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      query      TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT},
      updated_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );

    CREATE TABLE IF NOT EXISTS note_processing_state (
      note_id          TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL DEFAULT '',
      paused           INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id         TEXT PRIMARY KEY,
      job_id     TEXT NOT NULL,
      note_id    TEXT NOT NULL DEFAULT '',
      user_id    TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      message    TEXT NOT NULL DEFAULT '',
      meta_json  TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job_id_created_at ON job_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS note_drafts (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL DEFAULT '',
      audio_blob_id   TEXT NOT NULL DEFAULT '',
      audio_mime      TEXT NOT NULL DEFAULT 'application/octet-stream',
      audio_bytes     INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL DEFAULT ${NOW_ISO_DEFAULT}
    );
    CREATE INDEX IF NOT EXISTS idx_note_drafts_updated_at ON note_drafts(updated_at);
  `);

  // FTS replacement: notes.tsv (generated tsvector) + GIN index.
  // We add it via ALTER TABLE so existing rows (after migration) get backfilled by
  // Postgres automatically when STORED.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notes' AND column_name = 'tsv'
      ) THEN
        EXECUTE 'ALTER TABLE notes ADD COLUMN tsv tsvector
                 GENERATED ALWAYS AS (
                   setweight(to_tsvector(''english'', coalesce(title, '''')), ''A'') ||
                   setweight(to_tsvector(''english'', coalesce(body,  '''')), ''B'')
                 ) STORED';
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_notes_tsv ON notes USING GIN (tsv);
  `);
}

/* ---------------------------------------------------------------------------
 * FTS query translation
 *
 * The original SQLite path produces queries like `foo* bar*` (FTS5 prefix syntax).
 * Postgres tsquery with prefix is `foo:* & bar:*`. This helper translates that
 * shape, ignoring any other characters defensively.
 * ------------------------------------------------------------------------- */

export function convertSqliteFtsToPostgresTsquery(ftsQ) {
  const s = (ftsQ ?? '').toString().trim();
  if (!s) return '';
  const tokens = s.match(/[\p{L}\p{N}]+\*?/gu) ?? [];
  if (!tokens.length) return '';
  return tokens
    .map((t) => {
      const bare = t.endsWith('*') ? t.slice(0, -1) : t;
      // Always prefix-match; the SQLite path always appends `*`.
      return `${bare}:*`;
    })
    .join(' & ');
}
