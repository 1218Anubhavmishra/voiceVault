import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPaths, openDb } from '../server/db.js';

const db = openDb();
const { audioDir, blobsDir } = getPaths();

const LIMIT = Number(process.env.LIMIT ?? '0') || 0;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

ensureDir(blobsDir);

const rows = db
  .prepare(
    `SELECT id, audio_blob_id, audio_filename, audio_mime, audio_blob, audio_bytes
     FROM notes
     ORDER BY created_at ASC`
  )
  .all();

const update = db.prepare(
  `UPDATE notes
   SET audio_blob_id = @audio_blob_id,
       audio_bytes = @audio_bytes,
       updated_at = @updated_at
   WHERE id = @id`
);

let scanned = 0;
let updated = 0;
let already = 0;
let missing = 0;
let bytesWritten = 0;

for (const r of rows) {
  scanned += 1;
  if (LIMIT > 0 && updated >= LIMIT) break;

  const existing = (r?.audio_blob_id ?? '').toString().trim();
  if (existing) {
    already += 1;
    continue;
  }

  let buf = null;
  if (r?.audio_blob && r.audio_blob.length) {
    buf = Buffer.from(r.audio_blob);
  } else {
    const audioFilename = (r?.audio_filename ?? '').toString().trim();
    if (audioFilename) {
      const audioPath = path.join(audioDir, audioFilename);
      if (fs.existsSync(audioPath)) buf = fs.readFileSync(audioPath);
    }
  }

  if (!buf || !buf.length) {
    missing += 1;
    continue;
  }

  const blobId = sha256Hex(buf);
  const blobPath = path.join(blobsDir, blobId);
  if (!fs.existsSync(blobPath)) {
    fs.writeFileSync(blobPath, buf);
    bytesWritten += buf.length;
  }

  update.run({
    id: r.id,
    audio_blob_id: blobId,
    audio_bytes: buf.length,
    updated_at: new Date().toISOString()
  });
  updated += 1;
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      audioDir,
      blobsDir,
      scanned,
      already,
      updated,
      missing,
      bytesWritten
    },
    null,
    2
  )
);

