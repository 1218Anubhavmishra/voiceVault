import fs from 'node:fs';
import path from 'node:path';
import { getPaths, openDb } from '../server/db.js';

const DELETE_FILES = (process.env.DELETE_FILES ?? '').toString().trim() === '1';

const db = openDb();
const { audioDir } = getPaths();

const rows = db
  .prepare(
    `SELECT id, audio_filename, audio_mime, audio_bytes, length(audio_blob) AS blob_len
     FROM notes
     ORDER BY created_at ASC`
  )
  .all();

const update = db.prepare(
  `UPDATE notes
   SET audio_blob = @audio_blob,
       audio_bytes = @audio_bytes,
       audio_mime = @audio_mime
   WHERE id = @id`
);

let scanned = 0;
let alreadyInDb = 0;
let migrated = 0;
let missingFile = 0;
let deleted = 0;
let bytesMigrated = 0;

for (const r of rows) {
  scanned += 1;
  const blobLen = Number(r?.blob_len ?? 0) || 0;
  if (blobLen > 0) {
    alreadyInDb += 1;
    continue;
  }

  const audioFilename = (r?.audio_filename ?? '').toString();
  if (!audioFilename) {
    missingFile += 1;
    continue;
  }

  const audioPath = path.join(audioDir, audioFilename);
  if (!fs.existsSync(audioPath)) {
    missingFile += 1;
    continue;
  }

  const buf = fs.readFileSync(audioPath);
  update.run({
    id: r.id,
    audio_blob: buf,
    audio_bytes: buf.length,
    audio_mime: (r?.audio_mime ?? 'application/octet-stream').toString()
  });

  migrated += 1;
  bytesMigrated += buf.length;

  if (DELETE_FILES) {
    try {
      fs.unlinkSync(audioPath);
      deleted += 1;
    } catch {
      // ignore
    }
  }
}

const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      audioDir,
      delete_files: DELETE_FILES,
      scanned,
      alreadyInDb,
      migrated,
      missingFile,
      deleted,
      bytesMigrated,
      mbMigrated: mb(bytesMigrated)
    },
    null,
    2
  )
);

