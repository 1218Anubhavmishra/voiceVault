import Database from 'better-sqlite3';
import path from 'node:path';
import { nanoid } from 'nanoid';

const dbPath = path.resolve(process.cwd(), 'data', 'voicevault.sqlite');
const db = new Database(dbPath);

const LIMIT = Number(process.env.LIMIT ?? '0') || 0;

// Notes that either have no segment rows, or have segment rows but no words_json filled.
const rows = db
  .prepare(
    `SELECT n.id
     FROM notes n
     WHERE n.status = 'ready'
       AND (
         NOT EXISTS (SELECT 1 FROM note_segments ns WHERE ns.note_id = n.id)
         OR EXISTS (
           SELECT 1
           FROM note_segments ns
           WHERE ns.note_id = n.id
             AND (ns.words_json IS NULL OR trim(ns.words_json) = '')
           LIMIT 1
         )
       )
     ORDER BY n.created_at ASC`
  )
  .all();

const insert = db.prepare(
  `INSERT INTO ingestion_jobs (id, job_type, note_id, status, attempts, max_attempts, locked_at, last_error, created_at, updated_at)
   VALUES (@id, @job_type, @note_id, @status, @attempts, @max_attempts, @locked_at, @last_error, @created_at, @updated_at)`
);

const now = new Date().toISOString();
let queued = 0;
let scanned = 0;

for (const r of rows) {
  scanned += 1;
  if (LIMIT > 0 && queued >= LIMIT) break;
  const noteId = (r?.id ?? '').toString().trim();
  if (!noteId) continue;

  insert.run({
    id: nanoid(12),
    job_type: 'backfill_words',
    note_id: noteId,
    status: 'queued',
    attempts: 0,
    max_attempts: 2,
    locked_at: '',
    last_error: '',
    created_at: now,
    updated_at: now
  });
  queued += 1;
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      dbPath,
      scanned,
      queued,
      limit: LIMIT
    },
    null,
    2
  )
);

