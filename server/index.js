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
  const { title } = req.body ?? {};
  const audio = req.file;

  if (!audio) return res.status(400).json({ error: 'Missing audio file' });

  const safeTitle = (title ?? '').toString().trim();

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const audioFilename = `${id}.${ext}`;
  const audioPath = path.join(audioDir, audioFilename);

  fs.writeFileSync(audioPath, audio.buffer);

  (async () => {
    let transcript = '';
    try {
      transcript = await transcribeAudioFile(audioPath, {
        model: process.env.WHISPER_MODEL || 'small',
        language: process.env.WHISPER_LANGUAGE || ''
      });
    } catch (e) {
      return res.status(500).json({
        error: 'Transcription failed',
        details: e?.message ?? String(e)
      });
    }

    const finalTitle =
      safeTitle ||
      (transcript ? transcript.slice(0, 64).trim() : '') ||
      'Untitled';

    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO notes (id, title, body, audio_filename, audio_mime, audio_bytes, created_at)
       VALUES (@id, @title, @body, @audio_filename, @audio_mime, @audio_bytes, @created_at)`
    ).run({
      id,
      title: finalTitle,
      body: transcript || '',
      audio_filename: audioFilename,
      audio_mime: audio.mimetype || 'application/octet-stream',
      audio_bytes: audio.size,
      created_at: createdAt
    });

    return res.status(201).json({ id, transcript });
  })();
});

app.post('/api/transcribe', upload.single('audio'), (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__query_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audio.buffer);

  (async () => {
    try {
      const transcript = await transcribeAudioFile(tmpPath, {
        model: process.env.WHISPER_MODEL || 'small',
        language: process.env.WHISPER_LANGUAGE || ''
      });
      res.json({ transcript });
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

app.get('/api/notes', (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const offset = clampInt(req.query.offset, 0, 100000, 0);

  let rows;
  if (!q) {
    rows = db
      .prepare(
        `SELECT id, title, body, created_at
         FROM notes
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
  } else {
    rows = db
      .prepare(
        `SELECT n.id, n.title, n.body, n.created_at,
                bm25(notes_fts, 10.0, 1.0) AS rank
         FROM notes_fts
         JOIN notes n ON n.rowid = notes_fts.rowid
         WHERE notes_fts MATCH ?
         ORDER BY rank
         LIMIT ? OFFSET ?`
      )
      .all(normalizeFtsQuery(q), limit, offset);
  }

  res.json({ q, items: rows });
});

app.get('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  const row = db
    .prepare(
      `SELECT id, title, body, audio_filename, audio_mime, audio_bytes, created_at
       FROM notes
       WHERE id = ?`
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
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
  // Escape quotes to avoid invalid SQL FTS syntax.
  const cleaned = q.replaceAll('"', ' ').trim();
  const terms = cleaned.split(/\s+/g).filter(Boolean);
  if (terms.length === 0) return '';
  return terms.map((t) => `${t}*`).join(' ');
}

