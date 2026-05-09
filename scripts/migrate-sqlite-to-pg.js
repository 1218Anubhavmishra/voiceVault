/**
 * One-shot SQLite -> Postgres data migration.
 *
 * Reads `data/voicevault.sqlite` (or VV_DATA_DIR/voicevault.sqlite) and copies every
 * row in every user-data table into the Postgres database pointed to by DATABASE_URL.
 *
 * Idempotent: each row is upserted by primary key (`ON CONFLICT ... DO UPDATE`).
 * You can re-run the script safely; it will overwrite Postgres rows with whatever is
 * currently in SQLite. The notes_fts shadow tables are skipped — Postgres regenerates
 * `notes.tsv` automatically when notes rows are inserted.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.js
 *
 * Optional env:
 *   VV_DATA_DIR     Custom data directory (defaults to <repo>/data)
 *   DATABASE_URL    Postgres connection string (required)
 */

import './_load_env.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = process.env.VV_DATA_DIR ? path.resolve(process.env.VV_DATA_DIR) : path.resolve(repoRoot, 'data');
const sqlitePath = path.join(dataDir, 'voicevault.sqlite');

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found at ${sqlitePath}`);
  process.exit(1);
}

const connStr = (process.env.DATABASE_URL ?? '').toString().trim();
if (!connStr) {
  console.error('DATABASE_URL is not set. Set it in .env first.');
  process.exit(1);
}

const useSsl = /render\.com/i.test(connStr) || /\bsslmode=require\b/i.test(connStr);
const pool = new Pool({
  connectionString: connStr,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  max: 5
});

const sqlite = new Database(sqlitePath, { readonly: true });

/* ---------------------------------------------------------------------------
 * Table-by-table copy plan
 *
 * Each entry lists the SQLite SELECT and the Postgres INSERT (with named params).
 * `cols` is the canonical list of columns we map; missing-but-nullable columns in
 * the source row are normalized to safe defaults so the Postgres INSERT never fails
 * because of a NOT NULL constraint.
 * ------------------------------------------------------------------------- */

const TABLES = [
  {
    name: 'users',
    cols: ['id', 'email', 'password_hash', 'display_name', 'avatar_blob_id', 'created_at', 'updated_at'],
    pk: ['id'],
    defaults: { display_name: '', avatar_blob_id: '' }
  },
  {
    name: 'notes',
    cols: [
      'id', 'user_id', 'title', 'display_title', 'body', 'segments_json',
      'audio_filename', 'audio_blob_id', 'audio_mime', 'audio_bytes',
      'audio_blob', 'duration_ms', 'language', 'stt_provider', 'transcribe_mode',
      'created_at', 'updated_at', 'status', 'error', 'folder_id', 'is_favorite'
    ],
    pk: ['id'],
    defaults: {
      user_id: '', display_title: '', segments_json: '', audio_blob_id: '',
      audio_blob: Buffer.alloc(0),
      duration_ms: 0, language: '', stt_provider: 'whisper', transcribe_mode: '',
      status: 'processing', error: '', folder_id: '', is_favorite: 0
    }
  },
  {
    name: 'note_segments',
    cols: ['note_id', 'seg_idx', 'start_sec', 'end_sec', 'text', 'words_json', 'embedding', 'embed_model', 'created_at', 'updated_at'],
    pk: ['note_id', 'seg_idx'],
    defaults: { start_sec: 0, end_sec: 0, text: '', words_json: '', embedding: null, embed_model: '' }
  },
  {
    name: 'note_chunks',
    cols: ['note_id', 'chunk_idx', 'start_sec', 'end_sec', 'text', 'seg_start_idx', 'seg_end_idx', 'embedding', 'embed_model', 'created_at', 'updated_at'],
    pk: ['note_id', 'chunk_idx'],
    defaults: { start_sec: 0, end_sec: 0, text: '', seg_start_idx: 0, seg_end_idx: 0, embedding: null, embed_model: '' }
  },
  {
    name: 'ingestion_jobs',
    cols: ['id', 'job_type', 'note_id', 'user_id', 'status', 'attempts', 'max_attempts', 'locked_at', 'available_at', 'priority', 'last_error', 'created_at', 'updated_at'],
    pk: ['id'],
    defaults: { user_id: '', status: 'queued', attempts: 0, max_attempts: 3, locked_at: '', available_at: '', priority: 0, last_error: '' }
  },
  {
    name: 'app_state',
    cols: ['key', 'value', 'updated_at'],
    pk: ['key'],
    defaults: { value: '' }
  },
  {
    name: 'folders',
    cols: ['id', 'user_id', 'name', 'created_at', 'updated_at'],
    pk: ['id'],
    defaults: { user_id: '' }
  },
  {
    name: 'tags',
    cols: ['id', 'user_id', 'name', 'created_at', 'updated_at'],
    pk: ['id'],
    defaults: { user_id: '' }
  },
  {
    name: 'note_tags',
    cols: ['note_id', 'tag_id', 'created_at'],
    pk: ['note_id', 'tag_id']
  },
  {
    name: 'saved_searches',
    cols: ['id', 'user_id', 'name', 'query', 'created_at', 'updated_at'],
    pk: ['id'],
    defaults: { user_id: '' }
  },
  {
    name: 'note_processing_state',
    cols: ['note_id', 'user_id', 'paused', 'cancel_requested', 'updated_at'],
    pk: ['note_id'],
    defaults: { user_id: '', paused: 0, cancel_requested: 0 }
  },
  {
    name: 'job_events',
    cols: ['id', 'job_id', 'note_id', 'user_id', 'event_type', 'message', 'meta_json', 'created_at'],
    pk: ['id'],
    defaults: { note_id: '', user_id: '', message: '', meta_json: '' }
  },
  {
    name: 'note_drafts',
    cols: ['id', 'user_id', 'audio_blob_id', 'audio_mime', 'audio_bytes', 'duration_ms', 'created_at', 'updated_at'],
    pk: ['id'],
    defaults: { user_id: '', audio_blob_id: '', audio_mime: 'application/octet-stream', audio_bytes: 0, duration_ms: 0 }
  }
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeRow(row, table) {
  const out = {};
  for (const c of table.cols) {
    if (row[c] !== undefined && row[c] !== null) {
      out[c] = row[c];
    } else if (table.defaults && c in table.defaults) {
      out[c] = table.defaults[c];
    } else if (c === 'created_at' || c === 'updated_at') {
      out[c] = nowIso();
    } else {
      // Last-resort defaults; let Postgres complain if a real NOT NULL column has no source.
      out[c] = null;
    }
  }
  return out;
}

function buildUpsertSql(table) {
  const placeholders = table.cols.map((_, i) => `$${i + 1}`).join(', ');
  const colList = table.cols.join(', ');
  const updateSet = table.cols
    .filter((c) => !table.pk.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', ');
  const onConflict = `ON CONFLICT (${table.pk.join(', ')}) DO UPDATE SET ${updateSet}`;
  return `INSERT INTO ${table.name} (${colList}) VALUES (${placeholders}) ${onConflict}`;
}

async function copyTable(client, table) {
  // Skip table if SQLite doesn't have it (legacy DBs may lack a table introduced later).
  const exists = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table.name);
  if (!exists) {
    console.log(`  [skip] ${table.name} (table not in SQLite)`);
    return { copied: 0 };
  }

  // Detect which of our cols actually exist in this SQLite DB; older DBs may be missing
  // newer columns added in later migrations.
  const sqliteColInfo = sqlite.prepare(`PRAGMA table_info(${table.name})`).all();
  const presentCols = new Set(sqliteColInfo.map((r) => r.name));
  const selectCols = table.cols.filter((c) => presentCols.has(c));
  if (selectCols.length === 0) {
    console.log(`  [skip] ${table.name} (no overlapping columns)`);
    return { copied: 0 };
  }

  const rows = sqlite.prepare(`SELECT ${selectCols.join(', ')} FROM ${table.name}`).all();
  if (rows.length === 0) {
    console.log(`  [ok ] ${table.name}: 0 rows`);
    return { copied: 0 };
  }

  const sql = buildUpsertSql(table);

  let copied = 0;
  for (const raw of rows) {
    const r = normalizeRow(raw, table);
    const values = table.cols.map((c) => r[c]);
    try {
      await client.query(sql, values);
      copied += 1;
    } catch (e) {
      console.error(`  [ERR] ${table.name} pk=${table.pk.map((k) => raw[k]).join('/')}: ${e.message}`);
      throw e;
    }
  }

  console.log(`  [ok ] ${table.name}: ${copied}/${rows.length} rows`);
  return { copied };
}

async function main() {
  console.log(`SQLite source: ${sqlitePath}`);
  console.log(`Postgres host: ${(new URL(connStr)).host}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let total = 0;
    for (const table of TABLES) {
      const { copied } = await copyTable(client, table);
      total += copied;
    }

    await client.query('COMMIT');
    console.log(`\nDone. Total rows copied/upserted: ${total}`);
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('\nMigration failed; rolled back.');
    console.error(e?.stack ?? e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main();
