import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { getPaths, openDb } from '../server/db.js';
import { transcribeAudioFile } from '../server/transcribe.js';

const db = openDb();
const { audioDir } = getPaths();

const MODEL = (process.env.WHISPER_MODEL ?? '').toString().trim() || 'medium';
const LANGUAGE = (process.env.WHISPER_LANGUAGE ?? '').toString().trim() || '';
const LIMIT = Number(process.env.LIMIT ?? '0') || 0;

const rows = db
  .prepare(
    `SELECT id,
            title,
            status,
            language,
            audio_filename,
            audio_mime,
            length(audio_blob) AS blob_len,
            segments_json
     FROM notes
     WHERE status = 'ready'
       AND (segments_json IS NULL OR trim(segments_json) = '')
     ORDER BY created_at ASC`
  )
  .all();

const update = db.prepare(
  `UPDATE notes
   SET segments_json = @segments_json,
       language = @language,
       updated_at = @updated_at
   WHERE id = @id`
);

let scanned = 0;
let attempted = 0;
let updated = 0;
let skippedNoAudio = 0;
let failed = 0;

for (const r of rows) {
  scanned += 1;
  if (LIMIT > 0 && attempted >= LIMIT) break;

  const id = (r?.id ?? '').toString().trim();
  if (!id) continue;

  const blobLen = Number(r?.blob_len ?? 0) || 0;
  const audioFilename = (r?.audio_filename ?? '').toString();
  const audioMime = (r?.audio_mime ?? '').toString();

  let audioBuf = null;
  if (blobLen > 0) {
    const row2 = db.prepare(`SELECT audio_blob FROM notes WHERE id = ?`).get(id);
    if (row2?.audio_blob && Buffer.isBuffer(row2.audio_blob) && row2.audio_blob.length > 0) {
      audioBuf = row2.audio_blob;
    }
  } else if (audioFilename) {
    const p = path.join(audioDir, audioFilename);
    if (fs.existsSync(p)) {
      try {
        audioBuf = fs.readFileSync(p);
      } catch {
        // ignore
      }
    }
  }

  if (!audioBuf || audioBuf.length === 0) {
    skippedNoAudio += 1;
    continue;
  }

  attempted += 1;
  const ext = mimeToExt(audioMime) || fileExt(audioFilename) || 'webm';
  const tmpPath = path.join(audioDir, `__backfill_${id}_${nanoid(6)}.${ext}`);
  try {
    fs.writeFileSync(tmpPath, audioBuf);
    const out = await transcribeAudioFile(tmpPath, { model: MODEL, language: LANGUAGE });
    const segments = Array.isArray(out?.segments) ? out.segments : [];
    const segmentsJson = safeStringifySegments(segments);
    if (!segmentsJson) {
      failed += 1;
      continue;
    }
    const updatedAt = new Date().toISOString();
    update.run({
      id,
      segments_json: segmentsJson,
      language: (r?.language ?? '').toString().trim() || (out?.language ?? '').toString().trim() || '',
      updated_at: updatedAt
    });
    updated += 1;
  } catch {
    failed += 1;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

// eslint-disable-next-line no-console
console.log(
  JSON.stringify(
    {
      model: MODEL,
      language: LANGUAGE,
      limit: LIMIT,
      scanned,
      attempted,
      updated,
      skippedNoAudio,
      failed
    },
    null,
    2
  )
);

function mimeToExt(mime) {
  if (!mime) return '';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('mp4')) return 'mp4';
  return '';
}

function fileExt(filename) {
  const f = (filename ?? '').toString();
  const m = f.match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

function safeStringifySegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const safe = [];
  for (const s of segments) {
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = (s?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    safe.push({ start, end, text });
  }
  if (safe.length === 0) return '';
  try {
    return JSON.stringify(safe);
  } catch {
    return '';
  }
}

