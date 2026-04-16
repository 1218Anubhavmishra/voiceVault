import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.cwd(), 'data');
const audioDir = path.join(dataDir, 'audio');
const dbPath = path.join(dataDir, 'voicevault.sqlite');

export function ensureDataDirs() {
  fs.mkdirSync(audioDir, { recursive: true });
}

export function getPaths() {
  return { dataDir, audioDir, dbPath };
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
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      audio_filename TEXT NOT NULL,
      audio_mime TEXT NOT NULL,
      audio_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
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
  `);
}

