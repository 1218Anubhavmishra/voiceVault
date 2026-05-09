import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor paths to the repo folder, not the caller's cwd.
// This avoids accidentally creating a fresh DB when launched from another tool/working directory.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = process.env.VV_DATA_DIR
  ? path.resolve(process.env.VV_DATA_DIR)
  : path.resolve(repoRoot, 'data');
const audioDir = path.join(dataDir, 'audio');
const blobsDir = path.join(dataDir, 'blobs');
const dbPath = path.join(dataDir, 'voicevault.sqlite');

export function ensureDataDirs() {
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(blobsDir, { recursive: true });
}

export function getPaths() {
  return { dataDir, audioDir, blobsDir, dbPath };
}

export function openDb() {
  ensureDataDirs();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_blob_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      display_title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      segments_json TEXT NOT NULL DEFAULT '',
      audio_filename TEXT NOT NULL,
      audio_blob_id TEXT NOT NULL DEFAULT '',
      audio_mime TEXT NOT NULL,
      audio_bytes INTEGER NOT NULL,
      audio_blob BLOB NOT NULL DEFAULT X'',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      language TEXT NOT NULL DEFAULT '',
      stt_provider TEXT NOT NULL DEFAULT 'whisper',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT NOT NULL DEFAULT '',
      folder_id TEXT NOT NULL DEFAULT '',
      is_favorite INTEGER NOT NULL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title,
      body,
      content='notes',
      content_rowid='rowid',
      tokenize='porter'
    );

    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
      INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TABLE IF NOT EXISTS note_segments (
      note_id TEXT NOT NULL,
      seg_idx INTEGER NOT NULL,
      start_sec REAL NOT NULL DEFAULT 0,
      end_sec REAL NOT NULL DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      words_json TEXT NOT NULL DEFAULT '',
      embedding BLOB,
      embed_model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (note_id, seg_idx)
    );

    CREATE INDEX IF NOT EXISTS idx_note_segments_note_id ON note_segments(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_segments_updated_at ON note_segments(updated_at);

    CREATE TABLE IF NOT EXISTS note_chunks (
      note_id TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      start_sec REAL NOT NULL DEFAULT 0,
      end_sec REAL NOT NULL DEFAULT 0,
      text TEXT NOT NULL DEFAULT '',
      seg_start_idx INTEGER NOT NULL DEFAULT 0,
      seg_end_idx INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      embed_model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (note_id, chunk_idx)
    );

    CREATE INDEX IF NOT EXISTS idx_note_chunks_note_id ON note_chunks(note_id);
    CREATE INDEX IF NOT EXISTS idx_note_chunks_updated_at ON note_chunks(updated_at);

    CREATE TABLE IF NOT EXISTS ingestion_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL, -- transcribe_note, embed_note
      note_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued', -- queued, running, done, error
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      locked_at TEXT NOT NULL DEFAULT '',
      available_at TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_status ON ingestion_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_note_id ON ingestion_jobs(note_id);

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS note_tags (
      note_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (note_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_note_tags_tag_id ON note_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_note_tags_note_id ON note_tags(note_id);

    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS note_processing_state (
      note_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      paused INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      note_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job_id_created_at ON job_events(job_id, created_at);
  `);

  try {
    const userCols = new Set(
      db
        .prepare(`PRAGMA table_info(users)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!userCols.has('avatar_blob_id')) {
      try {
        db.exec(`ALTER TABLE users ADD COLUMN avatar_blob_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // Lightweight migrations for existing local DBs.
  // (SQLite doesn't support IF NOT EXISTS on ADD COLUMN reliably across tooling.)
  const cols = new Set(
    db
      .prepare(`PRAGMA table_info(notes)`)
      .all()
      .map((r) => (r?.name ?? '').toString())
  );

  // --- multi-user (local profiles) ---
  if (!cols.has('user_id')) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      cols.add('user_id');
    } catch {
      // ignore
    }
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_user_created_at ON notes(user_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_user_folder_id ON notes(user_id, folder_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_user_favorite ON notes(user_id, is_favorite)`);
  } catch {
    // ignore
  }

  if (!cols.has('updated_at')) {
    db.exec(
      `ALTER TABLE notes ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );
  }
  if (!cols.has('status')) {
    db.exec(`ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'processing'`);
  }
  if (!cols.has('error')) {
    db.exec(`ALTER TABLE notes ADD COLUMN error TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('duration_ms')) {
    db.exec(`ALTER TABLE notes ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('language')) {
    db.exec(`ALTER TABLE notes ADD COLUMN language TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('folder_id')) {
    db.exec(`ALTER TABLE notes ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('is_favorite')) {
    db.exec(`ALTER TABLE notes ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('stt_provider')) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN stt_provider TEXT NOT NULL DEFAULT 'whisper'`);
    } catch {
      // ignore
    }
  }
  if (!cols.has('display_title')) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN display_title TEXT NOT NULL DEFAULT ''`);
      db.exec(`UPDATE notes SET display_title = title WHERE trim(display_title) = ''`);
    } catch {
      // ignore
    }
  }
  if (!cols.has('audio_blob')) {
    db.exec(`ALTER TABLE notes ADD COLUMN audio_blob BLOB NOT NULL DEFAULT X''`);
  }
  if (!cols.has('audio_blob_id')) {
    db.exec(`ALTER TABLE notes ADD COLUMN audio_blob_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('segments_json')) {
    db.exec(`ALTER TABLE notes ADD COLUMN segments_json TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('transcribe_mode')) {
    try {
      db.exec(`ALTER TABLE notes ADD COLUMN transcribe_mode TEXT NOT NULL DEFAULT ''`);
    } catch {
      // ignore
    }
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_folder_id ON notes(folder_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_is_favorite ON notes(is_favorite)`);
  } catch {
    // ignore
  }

  // note_segments migrations
  const segCols = new Set(
    db
      .prepare(`PRAGMA table_info(note_segments)`)
      .all()
      .map((r) => (r?.name ?? '').toString())
  );
  if (!segCols.has('words_json')) {
    try {
      db.exec(`ALTER TABLE note_segments ADD COLUMN words_json TEXT NOT NULL DEFAULT ''`);
    } catch {
      // ignore
    }
  }

  // ingestion_jobs migrations
  const jobCols = new Set(
    db
      .prepare(`PRAGMA table_info(ingestion_jobs)`)
      .all()
      .map((r) => (r?.name ?? '').toString())
  );
  if (!jobCols.has('available_at')) {
    try {
      db.exec(`ALTER TABLE ingestion_jobs ADD COLUMN available_at TEXT NOT NULL DEFAULT ''`);
    } catch {
      // ignore
    }
  }
  if (!jobCols.has('priority')) {
    try {
      db.exec(`ALTER TABLE ingestion_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // ignore
    }
  }
  if (!jobCols.has('user_id')) {
    try {
      db.exec(`ALTER TABLE ingestion_jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      jobCols.add('user_id');
    } catch {
      // ignore
    }
  }

  try {
    db.prepare(
      `UPDATE ingestion_jobs
       SET user_id = (
         SELECT n.user_id FROM notes n WHERE n.id = ingestion_jobs.note_id LIMIT 1
       )
       WHERE trim(user_id) = ''`
    ).run();
  } catch {
    // ignore
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_ready ON ingestion_jobs(status, available_at, created_at)`);
  } catch {
    // ignore
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_ready_priority ON ingestion_jobs(status, priority, available_at, created_at)`);
  } catch {
    // ignore
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS note_processing_state (
      note_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      paused INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
  } catch {
    // ignore
  }

  try {
    const npsCols = new Set(
      db
        .prepare(`PRAGMA table_info(note_processing_state)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!npsCols.has('user_id')) {
      try {
        db.exec(`ALTER TABLE note_processing_state ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
    if (!npsCols.has('cancel_requested')) {
      db.exec(`ALTER TABLE note_processing_state ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`);
    }
  } catch {
    // ignore
  }

  // saved_searches migrations
  try {
    const ssCols = new Set(
      db
        .prepare(`PRAGMA table_info(saved_searches)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!ssCols.has('user_id')) {
      try {
        db.exec(`ALTER TABLE saved_searches ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // folders/tags migrations
  try {
    const fCols = new Set(
      db
        .prepare(`PRAGMA table_info(folders)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!fCols.has('user_id')) {
      try {
        db.exec(`ALTER TABLE folders ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_user_name ON folders(user_id, name)`);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }

  try {
    const tCols = new Set(
      db
        .prepare(`PRAGMA table_info(tags)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!tCols.has('user_id')) {
      try {
        db.exec(`ALTER TABLE tags ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, name)`);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }

  // note_drafts migrations
  try {
    const ndCols = new Set(
      db
        .prepare(`PRAGMA table_info(note_drafts)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!ndCols.has('user_id')) {
      try {
        db.exec(`ALTER TABLE note_drafts ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // job_events migrations
  try {
    const jeCols = new Set(
      db
        .prepare(`PRAGMA table_info(job_events)`)
        .all()
        .map((r) => (r?.name ?? '').toString())
    );
    if (!jeCols.has('user_id')) {
      try {
        db.exec(`ALTER TABLE job_events ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      note_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_job_events_job_id_created_at ON job_events(job_id, created_at)`);
  } catch {
    // ignore
  }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS note_drafts (
      id TEXT PRIMARY KEY,
      audio_blob_id TEXT NOT NULL DEFAULT '',
      audio_mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      audio_bytes INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_drafts_updated_at ON note_drafts(updated_at)`);
  } catch {
    // ignore
  }

}

