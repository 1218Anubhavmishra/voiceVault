import Database from 'better-sqlite3';
import path from 'node:path';
import { nanoid } from 'nanoid';

const dbPath = path.resolve(process.cwd(), 'data', 'voicevault.sqlite');
const db = new Database(dbPath);

const LIMIT = Number(process.env.LIMIT ?? '0') || 0;
const MODE = (process.env.MODE ?? 'auto').toString().trim(); // auto | mark_ready | requeue

const now = new Date().toISOString();

const errorNotes = db
  .prepare(
    `SELECT id, title, body, segments_json, audio_blob_id, status, error, updated_at
     FROM notes
     WHERE status = 'error'
     ORDER BY updated_at DESC`
  )
  .all();

const markReady = db.prepare(
  `UPDATE notes
   SET status = 'ready', error = '', updated_at = @updated_at
   WHERE id = @id`
);

const enqueue = db.prepare(
  `INSERT INTO ingestion_jobs (id, job_type, note_id, status, attempts, max_attempts, locked_at, last_error, created_at, updated_at)
   VALUES (@id, @job_type, @note_id, @status, @attempts, @max_attempts, @locked_at, @last_error, @created_at, @updated_at)`
);

const setProcessing = db.prepare(
  `UPDATE notes
   SET status = 'processing', error = '', updated_at = @updated_at
   WHERE id = @id`
);

function hasUsableTranscript(n) {
  const bodyLen = (n?.body ?? '').toString().trim().length;
  const segLen = (n?.segments_json ?? '').toString().trim().length;
  return bodyLen > 0 && segLen > 0;
}

let scanned = 0;
let ready = 0;
let queued = 0;
let skipped = 0;

for (const n of errorNotes) {
  scanned += 1;
  if (LIMIT > 0 && scanned > LIMIT) break;

  const noteId = (n?.id ?? '').toString().trim();
  if (!noteId) continue;

  const transcriptOk = hasUsableTranscript(n);
  const blobOk = (n?.audio_blob_id ?? '').toString().trim().length > 0;

  if (MODE === 'mark_ready' || (MODE === 'auto' && transcriptOk)) {
    markReady.run({ id: noteId, updated_at: now });
    ready += 1;
    continue;
  }

  if (MODE === 'requeue' || MODE === 'auto') {
    if (!blobOk) {
      skipped += 1;
      continue;
    }

    // Move note back into processing and enqueue a fresh transcribe job.
    setProcessing.run({ id: noteId, updated_at: now });
    enqueue.run({
      id: nanoid(12),
      job_type: 'transcribe_note',
      note_id: noteId,
      status: 'queued',
      attempts: 0,
      max_attempts: 3,
      locked_at: '',
      last_error: '',
      created_at: now,
      updated_at: now
    });
    queued += 1;
    continue;
  }
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      dbPath,
      mode: MODE,
      limit: LIMIT,
      scanned,
      marked_ready: ready,
      requeued: queued,
      skipped
    },
    null,
    2
  )
);

