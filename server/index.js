import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { getPaths, openDb } from './db.js';
import { transcribeAudioFile } from './transcribe.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const db = openDb();
const { audioDir } = getPaths();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/notes', upload.single('audio'), (req, res) => {
  const { title, duration_ms, language, fast_mode, source_filename } = req.body ?? {};
  const audio = req.file;

  if (!audio) return res.status(400).json({ error: 'Missing audio file' });

  const safeTitle = (title ?? '').toString().trim();
  const safeDurationMs = clampInt(duration_ms, 0, 24 * 60 * 60 * 1000, 0);
  const safeLanguage = (language ?? '').toString().trim();
  const safeFastMode = (fast_mode ?? '').toString().trim() !== '0';
  const safeSourceFilename = (source_filename ?? '').toString().trim();

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const audioFilename = `${id}.${ext}`;
  const audioPath = path.join(audioDir, audioFilename);

  fs.writeFileSync(audioPath, audio.buffer);

  const createdAt = new Date().toISOString();
  const initialTitle = safeTitle || 'Untitled';
  db.prepare(
    `INSERT INTO notes (id, title, body, audio_filename, audio_mime, audio_bytes, duration_ms, language, created_at, updated_at, status, error)
     VALUES (@id, @title, @body, @audio_filename, @audio_mime, @audio_bytes, @duration_ms, @language, @created_at, @updated_at, @status, @error)`
  ).run({
    id,
    title: initialTitle,
    body: '',
    audio_filename: audioFilename,
    audio_mime: audio.mimetype || 'application/octet-stream',
    audio_bytes: audio.size,
    duration_ms: safeDurationMs,
    language: safeLanguage,
    created_at: createdAt,
    updated_at: createdAt,
    status: 'processing',
    error: ''
  });

  // Respond immediately; finish transcription in background.
  res.status(201).json({ id, status: 'processing' });

  (async () => {
    let transcript = '';
    let detectedLanguage = '';
    try {
      const out = await transcribeAudioFile(audioPath, {
        model: safeFastMode
          ? process.env.WHISPER_FAST_MODEL || process.env.WHISPER_LANG_MODEL || 'tiny'
          : process.env.WHISPER_MODEL || 'medium',
        language: safeLanguage || process.env.WHISPER_LANGUAGE || ''
      });
      transcript = out?.transcript ?? '';
      detectedLanguage = out?.language ?? '';
      transcript = formatTranscript(transcript);
      if (safeSourceFilename) {
        transcript = `${safeSourceFilename}\n\n${transcript}`.trim();
      }

      const finalTitle =
        safeTitle ||
        (transcript ? transcript.slice(0, 64).trim() : '') ||
        'Untitled';

      const updatedAt = new Date().toISOString();
      db.prepare(
        `UPDATE notes
         SET title = @title,
             body = @body,
             language = @language,
             status = @status,
             error = @error,
             updated_at = @updated_at
         WHERE id = @id`
      ).run({
        id,
        title: finalTitle,
        body: transcript || '',
        language: safeLanguage || detectedLanguage || '',
        status: 'ready',
        error: '',
        updated_at: updatedAt
      });
    } catch (e) {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `UPDATE notes
         SET status = @status,
             error = @error,
             updated_at = @updated_at
         WHERE id = @id`
      ).run({
        id,
        status: 'error',
        error: (e?.message ?? String(e)).slice(0, 2000),
        updated_at: updatedAt
      });
    }
  })();
});

app.post('/api/transcribe', upload.single('audio'), (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });
  const safeLanguage = (req.body?.language ?? '').toString().trim();
  const safeFastMode = (req.body?.fast_mode ?? '').toString().trim() !== '0';

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__query_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audio.buffer);

  (async () => {
    try {
      const out = await transcribeAudioFile(tmpPath, {
        model: safeFastMode
          ? process.env.WHISPER_FAST_MODEL || process.env.WHISPER_LANG_MODEL || 'tiny'
          : process.env.WHISPER_MODEL || 'medium',
        language: safeLanguage || process.env.WHISPER_LANGUAGE || ''
      });
      res.json({
        transcript: formatTranscript(out?.transcript ?? ''),
        language: out?.language ?? ''
      });
    } catch (e) {
      res.status(500).json({
        error: 'Transcription failed',
        details: e?.message ?? String(e)
      });
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  })();
});

app.post('/api/detect-language', upload.single('audio'), (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__lang_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audio.buffer);

  (async () => {
    try {
      const out = await transcribeAudioFile(tmpPath, {
        model: process.env.WHISPER_LANG_MODEL || process.env.WHISPER_MODEL || 'tiny',
        language: '' // force auto-detect
      });
      res.json({ language: out?.language ?? '' });
    } catch (e) {
      res.status(500).json({
        error: 'Language detection failed',
        details: e?.message ?? String(e)
      });
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  })();
});

app.post('/api/live-transcribe', upload.single('audio'), (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });
  const safeLanguage = (req.body?.language ?? '').toString().trim();

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__live_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audio.buffer);

  (async () => {
    try {
      const out = await transcribeAudioFile(tmpPath, {
        model: process.env.WHISPER_FAST_MODEL || process.env.WHISPER_LANG_MODEL || 'tiny',
        language: safeLanguage || process.env.WHISPER_LANGUAGE || ''
      });
      res.json({
        transcript: formatTranscript(out?.transcript ?? ''),
        language: out?.language ?? ''
      });
    } catch (e) {
      res.status(500).json({
        error: 'Live transcription failed',
        details: e?.message ?? String(e)
      });
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  })();
});

app.get('/api/notes', (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const offset = clampInt(req.query.offset, 0, 100000, 0);

  let rows;
  if (!q) {
    rows = db
      .prepare(
        `SELECT id, title, body, created_at, updated_at, status, error, duration_ms, language
         FROM notes
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
  } else {
    const ftsQ = normalizeFtsQuery(q);
    try {
      rows = db
        .prepare(
          `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.language,
                 bm25(notes_fts, 10.0, 1.0) AS rank
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           WHERE notes_fts MATCH ?
           ORDER BY rank
           LIMIT ? OFFSET ?`
        )
        .all(ftsQ, limit, offset);
    } catch {
      // FTS queries can throw on punctuation/operators from transcription.
      // Fall back to a safe substring search so the endpoint never hard-fails.
      const like = `%${q.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      rows = db
        .prepare(
          `SELECT id, title, body, created_at, updated_at, status, error, duration_ms, language
           FROM notes
           WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(like, like, limit, offset);
    }
  }

  res.json({ q, items: rows });
});

app.get('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  const row = db
    .prepare(
      `SELECT id, title, body, audio_filename, audio_mime, audio_bytes, duration_ms, language, created_at, updated_at, status, error
       FROM notes
       WHERE id = ?`
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.patch('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  const title = (req.body?.title ?? '').toString().trim();
  const body = (req.body?.body ?? '').toString();
  const language = (req.body?.language ?? '').toString().trim();

  const existing = db.prepare(`SELECT id FROM notes WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updatedAt = new Date().toISOString();
  db.prepare(
    `UPDATE notes
     SET title = @title,
         body = @body,
         language = @language,
         status = @status,
         error = @error,
         updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id,
    title: title || 'Untitled',
    body,
    language,
    status: 'ready',
    error: '',
    updated_at: updatedAt
  });

  res.json({ ok: true, id });
});

app.delete('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  const row = db.prepare(`SELECT audio_filename FROM notes WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);

  const audioPath = path.join(audioDir, row.audio_filename);
  try {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  } catch {
    // ignore
  }

  res.json({ ok: true, id });
});

app.get('/api/notes/:id/audio', (req, res) => {
  const { id } = req.params;
  const row = db
    .prepare(`SELECT audio_filename, audio_mime FROM notes WHERE id = ?`)
    .get(id);
  if (!row) return res.status(404).end();

  const audioPath = path.join(audioDir, row.audio_filename);
  if (!fs.existsSync(audioPath)) return res.status(404).end();

  res.setHeader('Content-Type', row.audio_mime || 'application/octet-stream');
  res.sendFile(audioPath);
});

app.post('/api/notes/:id/retry', (req, res) => {
  const { id } = req.params;
  const row = db
    .prepare(`SELECT id, audio_filename FROM notes WHERE id = ?`)
    .get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  const audioPath = path.join(audioDir, row.audio_filename);
  if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'Audio file missing' });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notes
     SET status = @status,
         error = @error,
         updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, status: 'processing', error: '', updated_at: now });

  res.json({ ok: true, id, status: 'processing' });

  (async () => {
    try {
      const transcript = await transcribeAudioFile(audioPath, {
        model: process.env.WHISPER_MODEL || 'medium',
        language: process.env.WHISPER_LANGUAGE || ''
      });

      const updatedAt = new Date().toISOString();
      db.prepare(
        `UPDATE notes
         SET body = @body,
             status = @status,
             error = @error,
             updated_at = @updated_at
         WHERE id = @id`
      ).run({
        id,
        body: transcript || '',
        status: 'ready',
        error: '',
        updated_at: updatedAt
      });
    } catch (e) {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `UPDATE notes
         SET status = @status,
             error = @error,
             updated_at = @updated_at
         WHERE id = @id`
      ).run({
        id,
        status: 'error',
        error: (e?.message ?? String(e)).slice(0, 2000),
        updated_at: updatedAt
      });
    }
  })();
});

const publicDir = path.resolve(process.cwd(), 'public');
app.use('/', express.static(publicDir));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`voiceVault running on http://localhost:${PORT}`);
});

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt((value ?? '').toString(), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function mimeToExt(mime) {
  if (!mime) return null;
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return null;
}

function normalizeFtsQuery(q) {
  // Convert plain text into a prefix query: "foo bar" => "foo* bar*"
  // Aggressively strip punctuation/operators so voice transcripts like:
  // "what was my idea?" don't crash MATCH parsing.
  const cleaned = (q ?? '')
    .toString()
    .normalize('NFKC')
    .replaceAll('"', ' ')
    .replaceAll("'", ' ')
    .trim();

  // Keep only unicode letters/numbers as terms.
  const terms = cleaned.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return '';
  return terms.map((t) => `${t}*`).join(' ');
}

function formatTranscript(text) {
  const raw = (text ?? '').toString();
  if (!raw) return '';
  // If Whisper output includes quotes, break lines around them for readability.
  return raw
    .replaceAll('“', '"')
    .replaceAll('”', '"')
    .replaceAll('"', '\n"\n')
    // Break lines after common punctuation for readability.
    // Use \s* because Whisper sometimes omits spaces after punctuation.
    .replace(/([.!?;:,])(?=\s*[\p{L}\p{N}])/gu, '$1\n')
    .replaceAll('\r\n', '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

