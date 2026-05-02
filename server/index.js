import cors from 'cors';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'node:url';
import { getPaths, openDb } from './db.js';
import { transcribeAudioFile } from './transcribe.js';
import { ensureNoteChunks, ensureNoteSegments, semanticSearch } from './semantic.js';
import { embedTexts, bufferToFloat32, cosineSim } from './embeddings.js';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
import archiver from 'archiver';
import unzipper from 'unzipper';

const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

let db = openDb();
const { dataDir, audioDir, blobsDir, dbPath } = getPaths();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const pinecone =
  process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX
    ? new Pinecone({ apiKey: process.env.PINECONE_API_KEY })
    : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

const uploadZip = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      try {
        const p = path.join(dataDir, 'imports');
        fs.mkdirSync(p, { recursive: true });
        cb(null, p);
      } catch (e) {
        cb(e, dataDir);
      }
    },
    filename(_req, file, cb) {
      const ts = new Date().toISOString().replaceAll(':', '-');
      const base = `import-${ts}-${nanoid(6)}.zip`;
      cb(null, base);
    }
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024 // 1GB
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ingestion: { paused: isIngestionPaused(db) } });
});

app.get('/api/debug/paths', (_req, res) => {
  try {
    const p = getPaths();
    res.json({
      ok: true,
      cwd: process.cwd(),
      dataDir: p.dataDir,
      blobsDir: p.blobsDir,
      dbPath: p.dbPath
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get('/api/debug/embeddings', (_req, res) => {
  try {
    const chunks = Number(db.prepare(`SELECT count(1) AS c FROM note_chunks`).get()?.c ?? 0) || 0;
    const embedded =
      Number(
        db
          .prepare(`SELECT count(1) AS c FROM note_chunks WHERE embedding IS NOT NULL AND length(embedding) > 0`)
          .get()?.c ?? 0
      ) || 0;
    res.json({ ok: true, chunks, embedded });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get('/api/debug/semantic-score', async (req, res) => {
  const q = (req.query.q ?? 'recording').toString().trim();
  try {
    const [qVec] = await embedTexts([q]);
    const row = db
      .prepare(
        `SELECT nc.note_id, nc.chunk_idx, nc.text, nc.embedding
         FROM note_chunks nc
         LIMIT 1`
      )
      .get();
    const docVec = bufferToFloat32(row?.embedding);
    const sem = cosineSim(qVec, docVec);
    res.json({
      ok: true,
      q,
      q_dim: qVec?.length ?? 0,
      doc_dim: docVec?.length ?? 0,
      cos: Number.isFinite(sem) ? sem : null,
      has_doc_embedding: !!(row?.embedding && row.embedding.length > 0)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get('/api/debug/embed', async (req, res) => {
  const q = (req.query.q ?? 'recording').toString().trim();
  try {
    const [v] = await embedTexts([q]);
    const arr = Array.from((v ?? []).slice(0, 6));
    let norm = 0;
    for (const x of v ?? []) norm += Number(x) * Number(x);
    norm = Math.sqrt(norm);
    res.json({ ok: true, q, dim: v?.length ?? 0, norm, head: arr });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post('/api/debug/force-semantic', async (req, res) => {
  const q = (req.body?.q ?? 'recording').toString().trim();
  try {
    const out = await semanticSearch(db, { query: q, topK: 10 });
    const embedded =
      Number(
        db
          .prepare(`SELECT count(1) AS c FROM note_chunks WHERE embedding IS NOT NULL AND length(embedding) > 0`)
          .get()?.c ?? 0
      ) || 0;
    res.json({ ok: true, q, items: out.items?.length ?? 0, embedded });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

/** Persisted `notes.language`: explicit user hint wins; otherwise model detection. */
function persistedNoteLanguage(hint, detected) {
  const h = (hint ?? '').toString().trim();
  const d = (detected ?? '').toString().trim();
  return h || d;
}

/** Trim STT language fields; drop placeholders that should not be stored as a real locale. */
function normalizeDetectedLanguage(raw) {
  const s = (raw ?? '').toString().trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'und' || lower === 'unknown' || lower === 'auto') return '';
  return s;
}

/**
 * Re-run STT to fill `notes.language` where it is empty (uses current pipeline: Whisper or Google Chirp via env).
 * Body: { limit?: number, dry_run?: boolean, language_hint?: string } — hint is passed to transcribe (empty = auto-detect).
 */
app.post('/api/debug/backfill-note-languages', async (req, res) => {
  const limit = clampInt(req.body?.limit, 1, 500, 25);
  const dryRun = !!(req.body?.dry_run ?? false);
  const languageHint = (req.body?.language_hint ?? '').toString().trim();

  try {
    const rows = db
      .prepare(
        `SELECT id, audio_blob_id, audio_mime, language
         FROM notes
         WHERE (language IS NULL OR trim(language) = '') AND status = 'ready'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(limit);

    if (dryRun) {
      return res.json({
        ok: true,
        dry_run: true,
        count: rows.length,
        ids: rows.map((r) => r.id)
      });
    }

    const model = process.env.WHISPER_LANG_MODEL || process.env.WHISPER_FAST_MODEL || 'tiny';
    const results = [];

    for (const row of rows) {
      const noteId = (row.id ?? '').toString();
      const blobId = (row.audio_blob_id ?? '').toString().trim();
      if (!noteId || !blobId) {
        results.push({ id: noteId, ok: false, error: 'missing_blob' });
        continue;
      }
      const blobPath = path.join(blobsDir, blobId);
      if (!fs.existsSync(blobPath)) {
        results.push({ id: noteId, ok: false, error: 'blob_missing' });
        continue;
      }

      const ext = mimeToExt(row.audio_mime) ?? 'webm';
      const tmpPath = path.join(audioDir, `__langbf_${noteId}.${ext}`);
      try {
        fs.writeFileSync(tmpPath, fs.readFileSync(blobPath));
        const out = await transcribeAudioFile(tmpPath, {
          model,
          language: languageHint || ''
        });
        const detected = (out?.language ?? '').toString().trim();
        const hint = (row.language ?? '').toString().trim();
        const finalLang = persistedNoteLanguage(hint, detected);
        if (finalLang) {
          const updatedAt = new Date().toISOString();
          db.prepare(`UPDATE notes SET language = @language, updated_at = @updated_at WHERE id = @id`).run({
            id: noteId,
            language: finalLang,
            updated_at: updatedAt
          });
          results.push({ id: noteId, ok: true, language: finalLang });
        } else {
          results.push({ id: noteId, ok: false, reason: 'no_language_from_model' });
        }
      } catch (e) {
        results.push({ id: noteId, ok: false, error: (e?.message ?? String(e)).slice(0, 500) });
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    }

    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get('/api/export.zip', (_req, res) => {
  const exportedAt = new Date().toISOString();

  let counts = { notes: 0, segments: 0, chunks: 0, jobs: 0, tags: 0, folders: 0 };
  try {
    counts.notes = Number(db.prepare(`SELECT count(1) AS c FROM notes`).get()?.c ?? 0) || 0;
    counts.segments = Number(db.prepare(`SELECT count(1) AS c FROM note_segments`).get()?.c ?? 0) || 0;
    counts.chunks = Number(db.prepare(`SELECT count(1) AS c FROM note_chunks`).get()?.c ?? 0) || 0;
    counts.jobs = Number(db.prepare(`SELECT count(1) AS c FROM ingestion_jobs`).get()?.c ?? 0) || 0;
    counts.tags = Number(db.prepare(`SELECT count(1) AS c FROM tags`).get()?.c ?? 0) || 0;
    counts.folders = Number(db.prepare(`SELECT count(1) AS c FROM folders`).get()?.c ?? 0) || 0;
  } catch {
    // ignore
  }

  const manifest = {
    app: 'voiceVault',
    export_version: 1,
    exported_at: exportedAt,
    counts
  };

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="voicevault-export-${exportedAt.replaceAll(':', '-')}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    try {
      res.status(500).end(String(err?.message ?? err));
    } catch {
      // ignore
    }
  });
  archive.pipe(res);

  // Manifest
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  // DB + WAL/SHM if present (WAL mode)
  try {
    if (fs.existsSync(dbPath)) archive.file(dbPath, { name: 'data/voicevault.sqlite' });
    const wal = `${dbPath}-wal`;
    const shm = `${dbPath}-shm`;
    if (fs.existsSync(wal)) archive.file(wal, { name: 'data/voicevault.sqlite-wal' });
    if (fs.existsSync(shm)) archive.file(shm, { name: 'data/voicevault.sqlite-shm' });
  } catch {
    // ignore
  }

  // Blobs directory (durable media)
  try {
    if (fs.existsSync(blobsDir)) archive.directory(blobsDir, 'data/blobs');
  } catch {
    // ignore
  }

  archive.finalize().catch(() => {
    // ignore
  });
});

app.post('/api/import', uploadZip.single('backup'), async (req, res) => {
  const filePath = (req.file?.path ?? '').toString();
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'Missing backup file' });

  const importedAt = new Date().toISOString();
  const importId = `import_${importedAt.replaceAll(':', '-')}_${nanoid(6)}`;
  const stagingDir = path.join(dataDir, `${importId}_staging`);
  const backupDir = path.join(dataDir, `${importId}_backup`);
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  let manifest = null;
  try {
    const zip = await unzipper.Open.file(filePath);
    const mf = zip.files.find((f) => (f.path ?? '').toString() === 'manifest.json');
    if (!mf) return res.status(400).json({ error: 'Missing manifest.json in zip' });
    const buf = await mf.buffer();
    manifest = JSON.parse(buf.toString('utf8'));
    if ((manifest?.app ?? '') !== 'voiceVault') return res.status(400).json({ error: 'Not a voiceVault export' });
    if (Number(manifest?.export_version ?? 0) !== 1) return res.status(400).json({ error: 'Unsupported export version' });

    // Extract files into stagingDir (guard against path traversal)
    for (const f of zip.files) {
      if (f.type !== 'File') continue;
      const rel = (f.path ?? '').toString();
      if (!rel) continue;
      // Allow only manifest.json and data/*
      if (!(rel === 'manifest.json' || rel.startsWith('data/'))) continue;

      const norm = path.normalize(rel).replaceAll('\\', '/');
      if (norm.startsWith('../') || norm.startsWith('..\\')) continue;
      const outPath = path.join(stagingDir, norm);
      const outDir = path.dirname(outPath);
      fs.mkdirSync(outDir, { recursive: true });
      const data = await f.buffer();
      fs.writeFileSync(outPath, data);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid zip', details: e?.message ?? String(e) });
  }

  // Validate presence of DB and blobs dir (blobs may be empty but directory should exist in export)
  const stagedDb = path.join(stagingDir, 'data', 'voicevault.sqlite');
  const stagedWal = path.join(stagingDir, 'data', 'voicevault.sqlite-wal');
  const stagedShm = path.join(stagingDir, 'data', 'voicevault.sqlite-shm');
  const stagedBlobs = path.join(stagingDir, 'data', 'blobs');
  if (!fs.existsSync(stagedDb)) return res.status(400).json({ error: 'Missing data/voicevault.sqlite in zip' });

  // Pause ingestion + stop worker + swap files safely.
  try {
    setAppState(db, 'ingestion_paused', '1');
  } catch {
    // ignore
  }

  try {
    stopIngestionWorker();
  } catch {
    // ignore
  }

  try {
    db.close();
  } catch {
    // ignore
  }

  try {
    // Backup current DB + blobs
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, path.join(backupDir, 'voicevault.sqlite'));
    if (fs.existsSync(`${dbPath}-wal`)) fs.renameSync(`${dbPath}-wal`, path.join(backupDir, 'voicevault.sqlite-wal'));
    if (fs.existsSync(`${dbPath}-shm`)) fs.renameSync(`${dbPath}-shm`, path.join(backupDir, 'voicevault.sqlite-shm'));
    if (fs.existsSync(blobsDir)) fs.renameSync(blobsDir, path.join(backupDir, 'blobs'));

    // Apply staged files
    fs.renameSync(stagedDb, dbPath);
    if (fs.existsSync(stagedWal)) fs.renameSync(stagedWal, `${dbPath}-wal`);
    if (fs.existsSync(stagedShm)) fs.renameSync(stagedShm, `${dbPath}-shm`);
    if (fs.existsSync(stagedBlobs)) {
      // Ensure target blobs dir doesn't exist (it was moved above)
      fs.renameSync(stagedBlobs, blobsDir);
    } else {
      fs.mkdirSync(blobsDir, { recursive: true });
    }

    // Reopen DB + restart worker
    db = openDb();
    startIngestionWorker();
    try {
      setAppState(db, 'ingestion_paused', '0');
    } catch {
      // ignore
    }
  } catch (e) {
    // Attempt to restore backup if apply failed
    try {
      if (fs.existsSync(path.join(backupDir, 'voicevault.sqlite'))) fs.renameSync(path.join(backupDir, 'voicevault.sqlite'), dbPath);
      if (fs.existsSync(path.join(backupDir, 'voicevault.sqlite-wal'))) fs.renameSync(path.join(backupDir, 'voicevault.sqlite-wal'), `${dbPath}-wal`);
      if (fs.existsSync(path.join(backupDir, 'voicevault.sqlite-shm'))) fs.renameSync(path.join(backupDir, 'voicevault.sqlite-shm'), `${dbPath}-shm`);
      if (fs.existsSync(path.join(backupDir, 'blobs'))) fs.renameSync(path.join(backupDir, 'blobs'), blobsDir);
    } catch {
      // ignore
    }
    db = openDb();
    startIngestionWorker();
    return res.status(500).json({ error: 'Import failed', details: e?.message ?? String(e) });
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  res.json({ ok: true, imported_at: importedAt, manifest, backup_dir: backupDir });
});

app.get('/api/ingestion', (_req, res) => {
  res.json({ paused: isIngestionPaused(db) });
});

app.post('/api/ingestion/pause', (_req, res) => {
  setAppState(db, 'ingestion_paused', '1');
  res.json({ ok: true, paused: true });
});

app.post('/api/ingestion/resume', (_req, res) => {
  setAppState(db, 'ingestion_paused', '0');
  res.json({ ok: true, paused: false });
});

app.get('/api/jobs', (req, res) => {
  const status = (req.query.status ?? '').toString().trim();
  const limit = clampInt(req.query.limit, 1, 200, 40);
  const where = status ? `WHERE j.status = ?` : '';
  const args = status ? [status, limit] : [limit];
  const rows = db
    .prepare(
      `SELECT j.id, j.job_type, j.note_id, j.status, j.attempts, j.max_attempts, j.locked_at, j.last_error, j.created_at, j.updated_at,
              j.available_at,
              n.title AS note_title, n.status AS note_status
       FROM ingestion_jobs j
       LEFT JOIN notes n ON n.id = j.note_id
       ${where}
       ORDER BY j.updated_at DESC
       LIMIT ?`
    )
    .all(...args);
  res.json({ paused: isIngestionPaused(db), items: rows });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const limit = clampInt(req.query.limit, 1, 500, 200);
  try {
    const items = db
      .prepare(
        `SELECT id, job_id, note_id, event_type, message, meta_json, created_at
         FROM job_events
         WHERE job_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(id, limit);
    res.json({ ok: true, job_id: id, items });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch events', details: e?.message ?? String(e) });
  }
});

app.get('/api/processes/summary', (_req, res) => {
  const paused = isIngestionPaused(db);
  const maxParallel = getIngestionMaxParallel(db);
  const now = new Date().toISOString();
  const counts = db
    .prepare(
      `SELECT status, count(1) AS c
       FROM ingestion_jobs
       GROUP BY status`
    )
    .all();
  const byStatus = {};
  for (const r of counts) byStatus[(r?.status ?? '').toString()] = Number(r?.c ?? 0) || 0;

  const notes = db
    .prepare(
      `SELECT status, count(1) AS c
       FROM notes
       GROUP BY status`
    )
    .all();
  const notesByStatus = {};
  for (const r of notes) notesByStatus[(r?.status ?? '').toString()] = Number(r?.c ?? 0) || 0;

  let delayedQueued = 0;
  try {
    const row = db
      .prepare(
        `SELECT count(1) AS c
         FROM ingestion_jobs
         WHERE status = 'queued'
           AND available_at != ''
           AND available_at > ?`
      )
      .get(now);
    delayedQueued = Number(row?.c ?? 0) || 0;
  } catch {
    delayedQueued = 0;
  }

  const recentErrors = db
    .prepare(
      `SELECT id, title, substr(error, 1, 240) AS error, updated_at
       FROM notes
       WHERE status = 'error'
       ORDER BY updated_at DESC
       LIMIT 10`
    )
    .all();

  res.json({
    paused,
    max_parallel: maxParallel,
    jobs: byStatus,
    jobs_delayed_queued: delayedQueued,
    jobs_last_stale_unlock_at: getAppState(db, 'jobs_last_stale_unlock_at') || '',
    jobs_last_stale_unlock_count: Number(getAppState(db, 'jobs_last_stale_unlock_count') || 0) || 0,
    backoff_base_sec: getBackoffBaseSec(db),
    backoff_max_sec: getBackoffMaxSec(db),
    notes: notesByStatus,
    error_notes: recentErrors
  });
});

app.post('/api/processes/max-parallel', (req, res) => {
  const n = clampInt(req.body?.max_parallel, 1, 6, 1);
  setAppState(db, 'ingestion_max_parallel', String(n));
  res.json({ ok: true, max_parallel: n });
});

app.post('/api/processes/backoff', (req, res) => {
  const base = clampInt(req.body?.base_sec, 1, 60, 5);
  const max = clampInt(req.body?.max_sec, 5, 3600, 300);
  setAppState(db, 'ingestion_backoff_base_sec', String(base));
  setAppState(db, 'ingestion_backoff_max_sec', String(max));
  res.json({ ok: true, backoff_base_sec: base, backoff_max_sec: max });
});

app.post('/api/processes/retry-all-errors', (_req, res) => {
  const now2 = new Date().toISOString();
  let changed = 0;
  try {
    let ids = [];
    try {
      ids = db.prepare(`SELECT id, note_id, job_type FROM ingestion_jobs WHERE status = 'error' LIMIT 500`).all();
    } catch {
      ids = [];
    }
    const r = db
      .prepare(
        `UPDATE ingestion_jobs
         SET status = 'queued',
             attempts = 0,
             locked_at = '',
             available_at = '',
             last_error = '',
             updated_at = @now
         WHERE status = 'error'`
      )
      .run({ now: now2 });
    changed = Number(r?.changes ?? 0) || 0;
    if (changed > 0 && ids.length) {
      for (const j of ids) {
        appendJobEvent(db, {
          jobId: j?.id,
          noteId: (j?.note_id ?? '').toString(),
          eventType: 'bulk_retry',
          message: 'Job re-queued (retry all errors)',
          meta: { job_type: (j?.job_type ?? '').toString() }
        });
      }
    }
  } catch {
    changed = 0;
  }
  res.json({ ok: true, retried: changed });
});

app.post('/api/processes/unlock-stale', (_req, res) => {
  const count = unlockStaleJobs(db, { force: true });
  res.json({ ok: true, unlocked: count });
});

// --- Library metadata: folders/tags (local-only) ---

app.get('/api/folders', (_req, res) => {
  const items = db
    .prepare(`SELECT id, name, created_at, updated_at FROM folders ORDER BY name ASC`)
    .all();
  res.json({ items });
});

app.post('/api/folders', (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO folders (id, name, created_at, updated_at)
       VALUES (@id, @name, @created_at, @updated_at)`
    ).run({ id, name, created_at: now, updated_at: now });
    res.status(201).json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Folder already exists', details: e?.message ?? String(e) });
  }
});

app.patch('/api/folders/:id', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  const name = (req.body?.name ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const now = new Date().toISOString();
  try {
    const r = db
      .prepare(`UPDATE folders SET name = @name, updated_at = @updated_at WHERE id = @id`)
      .run({ id, name, updated_at: now });
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Folder already exists', details: e?.message ?? String(e) });
  }
});

app.delete('/api/folders/:id', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const now = new Date().toISOString();
  try {
    db.prepare(`UPDATE notes SET folder_id = '', updated_at = @updated_at WHERE folder_id = @id`).run({
      id,
      updated_at: now
    });
    const r = db.prepare(`DELETE FROM folders WHERE id = ?`).run(id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e?.message ?? String(e) });
  }
});

app.get('/api/tags', (_req, res) => {
  const items = db.prepare(`SELECT id, name, created_at, updated_at FROM tags ORDER BY name ASC`).all();
  res.json({ items });
});

app.post('/api/tags', (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO tags (id, name, created_at, updated_at) VALUES (@id,@name,@created_at,@updated_at)`).run({
      id,
      name,
      created_at: now,
      updated_at: now
    });
    res.status(201).json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Tag already exists', details: e?.message ?? String(e) });
  }
});

app.patch('/api/tags/:id', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  const name = (req.body?.name ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const now = new Date().toISOString();
  try {
    const r = db.prepare(`UPDATE tags SET name = @name, updated_at = @updated_at WHERE id = @id`).run({
      id,
      name,
      updated_at: now
    });
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Tag already exists', details: e?.message ?? String(e) });
  }
});

app.delete('/api/tags/:id', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    db.prepare(`DELETE FROM note_tags WHERE tag_id = ?`).run(id);
    const r = db.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e?.message ?? String(e) });
  }
});

app.get('/api/notes/:id/tags', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const items = db
    .prepare(
      `SELECT t.id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ?
       ORDER BY t.name ASC`
    )
    .all(id);
  res.json({ note_id: id, items });
});

app.post('/api/notes/:id/tags', (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const names = Array.isArray(req.body?.tags) ? req.body.tags : [];
  const cleaned = names
    .map((t) => (t ?? '').toString().trim())
    .filter(Boolean)
    .slice(0, 30);

  // Replace semantics: clear then insert.
  const now = new Date().toISOString();
  try {
    db.prepare(`DELETE FROM note_tags WHERE note_id = ?`).run(noteId);
    for (const name of cleaned) {
      let row = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name);
      if (!row) {
        const id = nanoid(12);
        try {
          db.prepare(`INSERT INTO tags (id, name, created_at, updated_at) VALUES (?,?,?,?)`).run(id, name, now, now);
          row = { id };
        } catch {
          row = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name);
        }
      }
      const tagId = (row?.id ?? '').toString();
      if (!tagId) continue;
      try {
        db.prepare(`INSERT OR IGNORE INTO note_tags (note_id, tag_id, created_at) VALUES (?,?,?)`).run(
          noteId,
          tagId,
          now
        );
      } catch {
        // ignore
      }
    }
    res.json({ ok: true, note_id: noteId, tags: cleaned });
  } catch (e) {
    res.status(500).json({ error: 'Update tags failed', details: e?.message ?? String(e) });
  }
});

// --- Saved searches (local-only) ---

app.get('/api/saved-searches', (_req, res) => {
  const items = db
    .prepare(`SELECT id, name, query, created_at, updated_at FROM saved_searches ORDER BY updated_at DESC`)
    .all();
  res.json({ items });
});

app.post('/api/saved-searches', (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  const query = (req.body?.query ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO saved_searches (id, name, query, created_at, updated_at)
       VALUES (@id, @name, @query, @created_at, @updated_at)`
    ).run({ id, name, query, created_at: now, updated_at: now });
    res.status(201).json({ ok: true, id, name, query });
  } catch (e) {
    res.status(500).json({ error: 'Create failed', details: e?.message ?? String(e) });
  }
});

app.patch('/api/saved-searches/:id', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  const name = (req.body?.name ?? '').toString().trim();
  const query = (req.body?.query ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!name && !query) return res.status(400).json({ error: 'Missing name/query' });
  const now = new Date().toISOString();
  const parts = [];
  if (name) parts.push(`name = @name`);
  if (query) parts.push(`query = @query`);
  parts.push(`updated_at = @updated_at`);
  try {
    const r = db
      .prepare(`UPDATE saved_searches SET ${parts.join(', ')} WHERE id = @id`)
      .run({ id, name, query, updated_at: now });
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Update failed', details: e?.message ?? String(e) });
  }
});

app.delete('/api/saved-searches/:id', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const r = db.prepare(`DELETE FROM saved_searches WHERE id = ?`).run(id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e?.message ?? String(e) });
  }
});

// --- Per-note processing controls (local-only) ---

app.post('/api/notes/:id/pause-processing', (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO note_processing_state (note_id, paused, updated_at)
       VALUES (@note_id, 1, @updated_at)
       ON CONFLICT(note_id) DO UPDATE SET paused = 1, updated_at = excluded.updated_at`
    ).run({ note_id: noteId, updated_at: now });
    res.json({ ok: true, note_id: noteId, paused: true });
  } catch (e) {
    res.status(500).json({ error: 'Pause failed', details: e?.message ?? String(e) });
  }
});

app.post('/api/notes/:id/resume-processing', (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO note_processing_state (note_id, paused, updated_at)
       VALUES (@note_id, 0, @updated_at)
       ON CONFLICT(note_id) DO UPDATE SET paused = 0, updated_at = excluded.updated_at`
    ).run({ note_id: noteId, updated_at: now });
    res.json({ ok: true, note_id: noteId, paused: false });
  } catch (e) {
    res.status(500).json({ error: 'Resume failed', details: e?.message ?? String(e) });
  }
});

function requestStopNoteJobs(db, noteId) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO note_processing_state (note_id, paused, cancel_requested, updated_at)
     VALUES (@note_id, 0, 1, @updated_at)
     ON CONFLICT(note_id) DO UPDATE SET cancel_requested = 1, updated_at = excluded.updated_at`
  ).run({ note_id: noteId, updated_at: now });
  db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'cancelled', last_error = 'Stopped', updated_at = @updated_at
     WHERE note_id = @note_id AND status = 'queued'`
  ).run({ note_id: noteId, updated_at: now });

  const running = db.prepare(`SELECT id FROM ingestion_jobs WHERE note_id = ? AND status = 'running'`).get(noteId);
  if (!running) {
    db.prepare(
      `UPDATE notes SET status = 'error', error = @error, updated_at = @updated_at WHERE id = @id AND status = 'processing'`
    ).run({
      id: noteId,
      error: 'Stopped by user',
      updated_at: now
    });
    db.prepare(`UPDATE note_processing_state SET cancel_requested = 0, updated_at = @updated_at WHERE note_id = @note_id`).run({
      note_id: noteId,
      updated_at: now
    });
  }
}

function consumeCancelIfRequested(db, noteId) {
  const row = db.prepare(`SELECT COALESCE(cancel_requested, 0) AS c FROM note_processing_state WHERE note_id = ?`).get(noteId);
  if (Number(row?.c ?? 0) !== 1) return false;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notes SET status = 'error', error = @error, updated_at = @updated_at WHERE id = @id AND status = 'processing'`
  ).run({
    id: noteId,
    error: 'Stopped by user',
    updated_at: now
  });
  db.prepare(`UPDATE note_processing_state SET cancel_requested = 0, updated_at = @updated_at WHERE note_id = @note_id`).run({
    note_id: noteId,
    updated_at: now
  });
  return true;
}

function throwIfTranscribeCancelled(db, noteId) {
  if (consumeCancelIfRequested(db, noteId)) {
    const e = new Error('__VV_CANCEL__');
    e.code = 'VV_CANCEL';
    throw e;
  }
}

/** Inline /retry has no running ingestion job: stop may set the note to `error` while clearing cancel — still must abort. */
function throwIfRetryInlineCancelled(db, noteId) {
  const row = db.prepare(`SELECT status FROM notes WHERE id = ?`).get(noteId);
  if (!row || (row.status ?? '').toString() !== 'processing') {
    const e = new Error('__VV_CANCEL__');
    e.code = 'VV_CANCEL';
    throw e;
  }
  throwIfTranscribeCancelled(db, noteId);
}

app.post('/api/notes/:id/stop-processing', (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  try {
    requestStopNoteJobs(db, noteId);
    res.json({ ok: true, note_id: noteId });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/processing/stop-all', (_req, res) => {
  try {
    const rows = db.prepare(`SELECT id FROM notes WHERE status = 'processing'`).all();
    for (const r of rows) {
      const id = (r?.id ?? '').toString().trim();
      if (id) requestStopNoteJobs(db, id);
    }
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post('/api/notes/:id/priority', (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const p = clampInt(req.body?.priority, -5, 5, 0);
  const now = new Date().toISOString();
  try {
    db.prepare(
      `UPDATE ingestion_jobs
       SET priority = @priority, updated_at = @updated_at
       WHERE note_id = @note_id AND status = 'queued'`
    ).run({ note_id: noteId, priority: p, updated_at: now });
    res.json({ ok: true, note_id: noteId, priority: p });
  } catch (e) {
    res.status(500).json({ error: 'Priority update failed', details: e?.message ?? String(e) });
  }
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const job = db.prepare(`SELECT id, note_id, job_type, status FROM ingestion_jobs WHERE id = ?`).get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const st = (job?.status ?? '').toString();
  if (st === 'running') return res.status(409).json({ error: 'Job is running; pause processing first' });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'cancelled', last_error = 'Cancelled', updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, updated_at: now });
  appendJobEvent(db, {
    jobId: id,
    noteId: (job?.note_id ?? '').toString(),
    eventType: 'cancelled',
    message: 'Job cancelled',
    meta: { job_type: (job?.job_type ?? '').toString() }
  });
  res.json({ ok: true, id, status: 'cancelled' });
});

app.post('/api/jobs/:id/retry', (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const job = db.prepare(`SELECT id, note_id, job_type FROM ingestion_jobs WHERE id = ?`).get(id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'queued', attempts = 0, locked_at = '', last_error = '', updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, updated_at: now });
  appendJobEvent(db, {
    jobId: id,
    noteId: (job?.note_id ?? '').toString(),
    eventType: 'manual_retry',
    message: 'Job manually re-queued',
    meta: { job_type: (job?.job_type ?? '').toString() }
  });
  res.json({ ok: true, id, status: 'queued' });
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

  const blobId = sha256Hex(audio.buffer);
  const blobPath = path.join(blobsDir, blobId);
  try {
    if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, audio.buffer);
  } catch {
    // ignore blob store failures; we still have audio_blob in SQLite.
  }

  const createdAt = new Date().toISOString();
  const initialTitle = safeTitle || 'Untitled';
  db.prepare(
    `INSERT INTO notes (id, title, body, segments_json, audio_filename, audio_blob_id, audio_mime, audio_bytes, audio_blob, duration_ms, language, created_at, updated_at, status, error)
     VALUES (@id, @title, @body, @segments_json, @audio_filename, @audio_blob_id, @audio_mime, @audio_bytes, @audio_blob, @duration_ms, @language, @created_at, @updated_at, @status, @error)`
  ).run({
    id,
    title: initialTitle,
    body: '',
    segments_json: '',
    audio_filename: audioFilename,
    audio_blob_id: blobId,
    audio_mime: audio.mimetype || 'application/octet-stream',
    audio_bytes: audio.size,
    audio_blob: audio.buffer,
    duration_ms: safeDurationMs,
    language: safeLanguage,
    created_at: createdAt,
    updated_at: createdAt,
    status: 'processing',
    error: ''
  });

  // Respond immediately; finish transcription in background.
  res.status(201).json({ id, status: 'processing' });
  enqueueJob(db, { job_type: 'transcribe_note', note_id: id });
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
        language: out?.language ?? '',
        segments: Array.isArray(out?.segments) ? out.segments : []
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
  const folderId = (req.query.folder_id ?? '').toString().trim();
  const statusFilter = (req.query.status ?? '').toString().trim();
  const tagName = (req.query.tag ?? '').toString().trim();
  const favoriteOnly = (req.query.favorite ?? '').toString().trim() === '1';

  const adv = parseAdvancedSearchOps(db, q);
  const { text: qText, fromIso, toIso } = extractTimeRangeAndText(adv.text);
  const hasTimeFilter = !!(fromIso && toIso);

  let rows;
  // If q is empty (or normalizes to no searchable terms), show all notes (optionally time filtered).
  const effectiveQuery = qText ? rewriteSearchQuery(qText) : '';
  const ftsQ = effectiveQuery ? normalizeFtsQuery(effectiveQuery) : '';
  const extraWhere = [];
  const extraArgs = [];
  if (folderId) {
    extraWhere.push(`n.folder_id = ?`);
    extraArgs.push(folderId);
  }
  if (statusFilter) {
    extraWhere.push(`n.status = ?`);
    extraArgs.push(statusFilter);
  }
  if (favoriteOnly) {
    extraWhere.push(`n.is_favorite = 1`);
  }
  if (tagName) {
    extraWhere.push(
      `EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)`
    );
    extraArgs.push(tagName);
  }
  if (adv.folder_id) {
    extraWhere.push(`n.folder_id = ?`);
    extraArgs.push(adv.folder_id);
  }
  if (adv.status) {
    extraWhere.push(`n.status = ?`);
    extraArgs.push(adv.status);
  }
  if (adv.favorite) {
    extraWhere.push(`n.is_favorite = 1`);
  }
  if (adv.tag) {
    extraWhere.push(
      `EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)`
    );
    extraArgs.push(adv.tag);
  }
  if (adv.title) {
    extraWhere.push(`n.title LIKE ? ESCAPE '\\'`);
    extraArgs.push(`%${adv.title.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
  }
  if (typeof adv.duration_min_ms === 'number') {
    extraWhere.push(`n.duration_ms >= ?`);
    extraArgs.push(adv.duration_min_ms);
  }
  if (typeof adv.duration_max_ms === 'number') {
    extraWhere.push(`n.duration_ms <= ?`);
    extraArgs.push(adv.duration_max_ms);
  }
  if (adv.has_words) {
    extraWhere.push(
      `EXISTS (SELECT 1 FROM note_segments ns WHERE ns.note_id = n.id AND ns.words_json != '')`
    );
  }
  const extraSql = extraWhere.length ? ` AND ${extraWhere.join(' AND ')}` : '';

  if ((!qText || !ftsQ) && !hasTimeFilter) {
    rows = db
      .prepare(
        `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.audio_filename, n.folder_id, n.is_favorite,
                COALESCE(nps.paused, 0) AS processing_paused
         FROM notes n
         LEFT JOIN note_processing_state nps ON nps.note_id = n.id
         WHERE 1=1${extraSql}
         ORDER BY n.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...extraArgs, limit, offset);
  } else if ((!qText || !ftsQ) && hasTimeFilter) {
    rows = db
      .prepare(
        `SELECT n.id, n.title, n.body, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.audio_filename, n.folder_id, n.is_favorite,
                COALESCE(nps.paused, 0) AS processing_paused
         FROM notes n
         LEFT JOIN note_processing_state nps ON nps.note_id = n.id
         WHERE n.created_at >= ? AND n.created_at <= ?${extraSql}
         ORDER BY n.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(fromIso, toIso, ...extraArgs, limit, offset);
  } else {
    try {
      rows = db
        .prepare(
          `SELECT n.id, n.title, n.body, n.segments_json, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.audio_filename, n.folder_id, n.is_favorite,
                 COALESCE(nps.paused, 0) AS processing_paused,
                 bm25(notes_fts, 10.0, 1.0) AS rank
           FROM notes_fts
           JOIN notes n ON n.rowid = notes_fts.rowid
           LEFT JOIN note_processing_state nps ON nps.note_id = n.id
           WHERE notes_fts MATCH ?
           ${hasTimeFilter ? 'AND n.created_at >= ? AND n.created_at <= ?' : ''}
           ${extraSql}
           ORDER BY rank
           LIMIT ? OFFSET ?`
        )
        .all(...(hasTimeFilter ? [ftsQ, fromIso, toIso] : [ftsQ]), ...extraArgs, limit, offset);
    } catch {
      // FTS queries can throw on punctuation/operators from transcription.
      // Fall back to a safe substring search so the endpoint never hard-fails.
      const like = `%${effectiveQuery.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      rows = db
        .prepare(
          `SELECT n.id, n.title, n.body, n.segments_json, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.audio_filename, n.folder_id, n.is_favorite,
                  COALESCE(nps.paused, 0) AS processing_paused
           FROM notes n
           LEFT JOIN note_processing_state nps ON nps.note_id = n.id
           WHERE (n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\')
           ${hasTimeFilter ? 'AND n.created_at >= ? AND n.created_at <= ?' : ''}
           ${extraSql}
           ORDER BY n.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(
          ...(hasTimeFilter ? [like, like, fromIso, toIso] : [like, like]),
          ...extraArgs,
          limit,
          offset
        );
    }

    // Second-stage re-ranking for better accuracy:
    // - Keeps FTS (fast) as candidate retrieval
    // - Improves ordering with word-level overlap + phrase/bigram matching
    rows = rerankSearchResults(effectiveQuery, rows);

    // Attach the best matching segment (timestamp range) for click-to-play.
    rows = rows.map((r) => {
      const matches = pickTopMatchSegments(effectiveQuery, r?.segments_json, 3);
      const best = matches[0] ?? null;
      if (!best) return r;
      return { ...r, best_match: best, matches };
    });
  }

  res.json({
    q,
    effective_q: effectiveQuery,
    time_filter: hasTimeFilter ? { from: fromIso, to: toIso } : null,
    items: rows
  });
});

app.get('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  const row = db
    .prepare(
      `SELECT id, title, body, segments_json, audio_filename, audio_blob_id, audio_mime, audio_bytes, duration_ms, language, created_at, updated_at, status, error, folder_id, is_favorite
       FROM notes
       WHERE id = ?`
    )
    .get(id);

  if (!row) return res.status(404).json({ error: 'Not found' });

  const segRows = db
    .prepare(
      `SELECT seg_idx, start_sec, end_sec, text, words_json
       FROM note_segments
       WHERE note_id = ?
       ORDER BY seg_idx ASC`
    )
    .all(id);

  const segments =
    segRows && segRows.length
      ? segRows.map((s) => ({
          start: Number(s.start_sec),
          end: Number(s.end_sec),
          text: (s.text ?? '').toString(),
          words: parseWordsJson(s.words_json)
        }))
      : parseSegmentsJson(row?.segments_json);

  res.json({
    ...row,
    audio_url: row?.audio_blob_id
      ? `/api/blobs/${encodeURIComponent(row.audio_blob_id)}`
      : `/api/notes/${encodeURIComponent(row.id)}/audio`,
    segments
  });
});

app.get('/api/semantic', async (req, res) => {
  const q = (req.query.q ?? '').toString().trim();
  const topK = clampInt(req.query.k, 1, 50, 10);
  const adv = parseAdvancedSearchOps(db, q);
  const { text: qText, fromIso, toIso } = extractTimeRangeAndText(adv.text);
  const effectiveQuery = qText ? rewriteSearchQuery(qText) : '';
  try {
    const out = await semanticSearch(db, {
      query: effectiveQuery,
      fromIso,
      toIso,
      topK,
      filters: {
        folder_id: (req.query.folder_id ?? '').toString().trim() || adv.folder_id || '',
        status: (req.query.status ?? '').toString().trim() || adv.status || '',
        tag: (req.query.tag ?? '').toString().trim() || adv.tag || '',
        favorite: (req.query.favorite ?? '').toString().trim() === '1' || adv.favorite,
        title: adv.title || '',
        duration_min_ms: adv.duration_min_ms ?? null,
        duration_max_ms: adv.duration_max_ms ?? null,
        has_words: !!adv.has_words
      }
    });
    res.json({
      q,
      effective_q: effectiveQuery,
      time_filter: fromIso && toIso ? { from: fromIso, to: toIso } : null,
      model: out.model,
      items: out.items
    });
  } catch (e) {
    res.status(500).json({ error: 'Semantic search failed', details: e?.message ?? String(e) });
  }
});

app.get('/api/semantic-pinecone', async (req, res) => {
  if (!pinecone) return res.status(400).json({ error: 'Pinecone not configured' });
  const q = (req.query.q ?? '').toString().trim();
  const topK = clampInt(req.query.k, 1, 50, 10);
  const { text: qText, fromIso, toIso } = extractTimeRangeAndText(q);
  const effectiveQuery = qText ? rewriteSearchQuery(qText) : '';
  try {
    // Lazy: if you want Pinecone, we push query embedding and search there.
    // (Indexing step would upload vectors per chunk; not enabled by default.)
    const index = pinecone.index(process.env.PINECONE_INDEX);
    const out = await semanticSearch(db, { query: effectiveQuery, fromIso, toIso, topK });
    // For now, return local semantic results and include a hint.
    res.json({
      q,
      effective_q: effectiveQuery,
      time_filter: fromIso && toIso ? { from: fromIso, to: toIso } : null,
      note: 'Pinecone client configured. Upload/indexing pipeline is the next step.',
      items: out.items
    });
    void index; // keep linter happy
  } catch (e) {
    res.status(500).json({ error: 'Pinecone semantic search failed', details: e?.message ?? String(e) });
  }
});

app.post('/api/answer', async (req, res) => {
  const q = (req.body?.q ?? '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Missing q' });
  const topK = clampInt(req.body?.k, 1, 30, 10);
  const modeReq = (req.body?.mode ?? 'auto').toString().trim().toLowerCase();
  const mode = ['auto', 'openai', 'ollama'].includes(modeReq) ? modeReq : 'auto';
  const { text: qText, fromIso, toIso } = extractTimeRangeAndText(q);
  const effectiveQuery = qText ? rewriteSearchQuery(qText) : '';

  let retrieved;
  try {
    retrieved = await semanticSearch(db, { query: effectiveQuery, fromIso, toIso, topK });
  } catch (e) {
    return res.status(500).json({ error: 'Retrieval failed', details: e?.message ?? String(e) });
  }

  const clips = [];
  for (const it of retrieved.items ?? []) {
    for (const m of (it?.matches ?? []).slice(0, 3)) {
      clips.push({
        note_id: it.id,
        title: it.title,
        start: m.start,
        end: m.end,
        text: m.text,
        score: m.score
      });
    }
    if (clips.length >= 12) break;
  }

  // OpenAI key: env or per-request header/body.
  const headerKey = (req.headers['x-openai-key'] ?? '').toString().trim();
  const bodyKey = (req.body?.openai_api_key ?? '').toString().trim();
  const apiKey = headerKey || bodyKey;

  const canOpenAi = !!openai || !!apiKey;
  const ollamaHost = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').toString().trim() || 'http://127.0.0.1:11434';
  const ollamaModel = (process.env.OLLAMA_MODEL ?? 'llama3.1').toString().trim() || 'llama3.1';

  const wantOllama = mode === 'ollama' || (mode === 'auto' && !canOpenAi);
  const wantOpenAi = mode === 'openai' || (mode === 'auto' && canOpenAi);

  if (wantOpenAi && canOpenAi) {
    try {
      const client = openai || new OpenAI({ apiKey });
      if (!client) {
        return res.json({ q, effective_q: effectiveQuery, mode: 'extractive', answer: '', clips });
      }
      const answer = await generateOpenAiAnswer(client, effectiveQuery, clips);
      return res.json({
        q,
        effective_q: effectiveQuery,
        mode: 'openai',
        model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
        answer,
        clips
      });
    } catch (e) {
      // If user explicitly asked openai, fail. If auto, we can fall back to ollama.
      if (mode === 'openai') {
        return res.status(500).json({ error: 'LLM answer failed', details: e?.message ?? String(e), clips });
      }
    }
  }

  if (mode === 'openai' && !canOpenAi) {
    // Don't hard-fail the UI: just return no-answer so the client can show a friendly hint.
    return res.json({
      q,
      effective_q: effectiveQuery,
      mode: 'extractive',
      answer: '',
      clips,
      hint: 'OpenAI not configured'
    });
  }

  if (wantOllama || mode === 'auto') {
    try {
      const answer = await generateOllamaAnswer({ host: ollamaHost, model: ollamaModel }, effectiveQuery, clips);
      return res.json({
        q,
        effective_q: effectiveQuery,
        mode: 'ollama',
        model: ollamaModel,
        answer,
        clips
      });
    } catch (e) {
      if (mode === 'ollama') {
        // Same: keep UI stable even if Ollama isn't running.
        return res.json({
          q,
          effective_q: effectiveQuery,
          mode: 'extractive',
          answer: '',
          clips,
          hint: 'Ollama unavailable',
          details: e?.message ?? String(e)
        });
      }
    }
  }

  return res.json({ q, effective_q: effectiveQuery, mode: 'extractive', answer: '', clips });
});

app.get('/api/ollama/health', async (_req, res) => {
  const host = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').toString().trim() || 'http://127.0.0.1:11434';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch(`${host.replace(/\/+$/, '')}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return res.status(503).json({ ok: false, error: `Ollama not ready (${r.status})` });
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.patch('/api/notes/:id', (req, res) => {
  const { id } = req.params;
  const title = (req.body?.title ?? '').toString().trim();
  const body = (req.body?.body ?? '').toString();
  const language = (req.body?.language ?? '').toString().trim();
  const folderId = (req.body?.folder_id ?? '').toString().trim();
  const favoriteRaw = req.body?.is_favorite;
  const hasFavorite = typeof favoriteRaw !== 'undefined';
  const isFavorite = hasFavorite ? ((favoriteRaw ?? 0).toString().trim() === '1' || favoriteRaw === true ? 1 : 0) : null;

  const existing = db.prepare(`SELECT id FROM notes WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updatedAt = new Date().toISOString();
  const parts = [
    `title = @title`,
    `body = @body`,
    `language = @language`,
    `status = @status`,
    `error = @error`,
    `updated_at = @updated_at`
  ];
  if (folderId) parts.push(`folder_id = @folder_id`);
  if (hasFavorite) parts.push(`is_favorite = @is_favorite`);
  const sql = `UPDATE notes SET ${parts.join(', ')} WHERE id = @id`;
  db.prepare(sql).run({
    id,
    title: title || 'Untitled',
    body,
    language,
    folder_id: folderId || '',
    is_favorite: isFavorite ?? 0,
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
    .prepare(`SELECT audio_filename, audio_blob_id, audio_mime, audio_blob FROM notes WHERE id = ?`)
    .get(id);
  if (!row) return res.status(404).end();

  // Prefer durable blob-store URL (enables clean media URLs + streaming).
  let blobId = (row.audio_blob_id ?? '').toString().trim();
  if (!blobId) {
    // Backfill durable blob id for older notes that only have audio_blob/disk.
  const blob = row.audio_blob;
  if (blob && Buffer.isBuffer(blob) && blob.length > 0) {
      try {
        blobId = sha256Hex(blob);
        const blobPath = path.join(blobsDir, blobId);
        if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, blob);
        try {
          db.prepare(`UPDATE notes SET audio_blob_id = @audio_blob_id WHERE id = @id`).run({
            id,
            audio_blob_id: blobId
          });
        } catch {
          // ignore
        }
      } catch {
        blobId = '';
      }
    }
  }
  if (blobId) return res.redirect(302, `/api/blobs/${encodeURIComponent(blobId)}`);

  const contentType = row.audio_mime || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = (req.headers.range ?? '').toString();

  const blob = row.audio_blob;
  if (blob && Buffer.isBuffer(blob) && blob.length > 0) {
    const size = blob.length;
    if (range.startsWith('bytes=')) {
      const { start, end } = parseRange(range, size);
      if (start === null) return res.status(416).end();
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return res.end(blob.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', String(size));
    return res.end(blob);
  }

  // Backward compatibility for older notes that stored audio on disk.
  const audioPath = path.join(audioDir, row.audio_filename);
  if (!fs.existsSync(audioPath)) return res.status(404).end();
  const stat = fs.statSync(audioPath);
  const size = stat.size;

  if (range.startsWith('bytes=')) {
    const { start, end } = parseRange(range, size);
    if (start === null) return res.status(416).end();
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    const stream = fs.createReadStream(audioPath, { start, end });
    return stream.pipe(res);
  }

  res.setHeader('Content-Length', String(size));
  const stream = fs.createReadStream(audioPath);
  return stream.pipe(res);
});

app.get('/api/blobs/:id', (req, res) => {
  const blobId = (req.params?.id ?? '').toString().trim();
  if (!blobId || !/^[a-f0-9]{64}$/i.test(blobId)) return res.status(400).end();
  const p = path.join(blobsDir, blobId);
  if (!fs.existsSync(p)) return res.status(404).end();

  // Content-Type: best-effort from notes table (fallback octet-stream).
  // If multiple notes reference a blob, pick any matching mime.
  const mimeRow = db
    .prepare(`SELECT audio_mime FROM notes WHERE audio_blob_id = ? AND audio_mime != '' LIMIT 1`)
    .get(blobId);
  const contentType = (mimeRow?.audio_mime ?? 'application/octet-stream').toString() || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  const stat = fs.statSync(p);
  const size = stat.size;
  const range = (req.headers.range ?? '').toString();
  if (range.startsWith('bytes=')) {
    const { start, end } = parseRange(range, size);
    if (start === null) return res.status(416).end();
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', String(size));
  return fs.createReadStream(p).pipe(res);
});

app.post('/api/notes/:id/retry', (req, res) => {
  const { id } = req.params;
  const row = db
    .prepare(`SELECT id, audio_filename, audio_mime, audio_blob, language FROM notes WHERE id = ?`)
    .get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  let audioBuf = null;
  if (row.audio_blob && Buffer.isBuffer(row.audio_blob) && row.audio_blob.length > 0) {
    audioBuf = row.audio_blob;
  } else {
    const audioPath = path.join(audioDir, row.audio_filename);
    if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'Audio missing' });
    audioBuf = fs.readFileSync(audioPath);
    try {
      db.prepare(`UPDATE notes SET audio_blob = @audio_blob WHERE id = @id`).run({
        id,
        audio_blob: audioBuf
      });
    } catch {
      // ignore
    }
  }

  const ext = mimeToExt(row.audio_mime) ?? 'webm';
  const tmpPath = path.join(audioDir, `__retry_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audioBuf);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE notes
     SET status = @status,
         error = @error,
         updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, status: 'processing', error: '', updated_at: now });

  // Resume any paused pipeline for this note and clear stop flags so queued workers can run; timer uses fresh updated_at.
  try {
    db.prepare(
      `INSERT INTO note_processing_state (note_id, paused, cancel_requested, updated_at)
       VALUES (@note_id, 0, 0, @updated_at)
       ON CONFLICT(note_id) DO UPDATE SET paused = 0, cancel_requested = 0, updated_at = excluded.updated_at`
    ).run({ note_id: id, updated_at: now });
  } catch {
    // ignore if columns mismatch old DB
  }

  res.json({ ok: true, id, status: 'processing' });

  (async () => {
    try {
      throwIfRetryInlineCancelled(db, id);

      let cancelledDuringTranscribe = false;
      const pollIv = setInterval(() => {
        try {
          throwIfRetryInlineCancelled(db, id);
        } catch (e) {
          if (e?.code === 'VV_CANCEL') cancelledDuringTranscribe = true;
        }
      }, 900);

      try {
        // Reprocess: always auto-detect language (do not use notes.language or WHISPER_LANGUAGE — they force a fixed lang and often yield empty "detection").
        const out = await transcribeAudioFile(tmpPath, {
          model: process.env.WHISPER_MODEL || 'medium',
          language: ''
        });

        if (cancelledDuringTranscribe) {
          const e = new Error('__VV_CANCEL__');
          e.code = 'VV_CANCEL';
          throw e;
        }
        throwIfRetryInlineCancelled(db, id);

      const transcript = formatTranscript(out?.transcript ?? out ?? '');
      const updatedAt = new Date().toISOString();
        const detectedLang = normalizeDetectedLanguage(out?.language);
        const priorLang = (row.language ?? '').toString().trim();
        const storedLang = (detectedLang || priorLang).toString().trim();

        const r = db
          .prepare(
        `UPDATE notes
         SET body = @body,
                 segments_json = @segments_json,
                 language = @language,
             status = @status,
             error = @error,
             updated_at = @updated_at
             WHERE id = @id AND status = 'processing'`
          )
          .run({
        id,
        body: transcript || '',
            segments_json: safeStringifySegments(out?.segments),
            language: storedLang,
        status: 'ready',
        error: '',
        updated_at: updatedAt
      });
        if (!r.changes) return;
    } catch (e) {
        if (e?.code === 'VV_CANCEL' || e?.message === '__VV_CANCEL__') return;

      const updatedAt = new Date().toISOString();
      db.prepare(
        `UPDATE notes
         SET status = @status,
             error = @error,
             updated_at = @updated_at
           WHERE id = @id AND status = 'processing'`
      ).run({
        id,
        status: 'error',
        error: (e?.message ?? String(e)).slice(0, 2000),
        updated_at: updatedAt
      });
      } finally {
        try {
          clearInterval(pollIv);
        } catch {
          // ignore
        }
      }
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  })();
});

// Background worker: durable ingestion queue (transcription + segment persistence).
// This keeps the app responsive and makes processing resilient.
let ingestionTimer = null;
function stopIngestionWorker() {
  if (!ingestionTimer) return;
  try {
    clearInterval(ingestionTimer);
  } catch {
    // ignore
  }
  ingestionTimer = null;
}
function startIngestionWorker() {
  stopIngestionWorker();
  ingestionTimer = startIngestionWorkerImpl(() => db, { blobsDir });
}
startIngestionWorker();

// Anchor static serving to the repo folder (not cwd) and disable caching
// so different runners (Cursor/Claude Code) don't appear to serve "old UI".
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.resolve(repoRoot, 'public');

app.use(
  '/',
  express.static(publicDir, {
    etag: false,
    lastModified: false,
    cacheControl: false,
    setHeaders(res, filePath) {
      // Aggressively disable caching for dev-like usage.
      // (Audio routes set their own headers separately.)
      if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    }
  })
);

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

function rewriteSearchQuery(q) {
  const raw = (q ?? '').toString().normalize('NFKC').toLowerCase();

  // If the query contains “about X / regarding X / on X”, prefer just X.
  // This makes queries like “find me the note where I talked about recording”
  // behave like a keyword search for “recording”.
  const m = raw.match(/\b(?:about|regarding|re|on)\b([\s\S]{0,200})$/i);
  const tail = m?.[1] ? m[1].trim() : '';
  const base = tail.length >= 2 ? tail : raw;

  const tokens = base.match(/[\p{L}\p{N}]+/gu) ?? [];

  if (tokens.length === 0) return '';

  // Cheap, offline “NL → keyword” rewrite:
  // remove common instruction/filler words so queries like
  // “find me the note where I talked about recording” become “talked recording”
  // (and porter stemming in FTS helps further).
  const STOP = new Set([
    'about',
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'but',
    'by',
    'could',
    'did',
    'do',
    'does',
    'for',
    'from',
    'find',
    'get',
    'give',
    'had',
    'has',
    'have',
    'i',
    'im',
    'in',
    'is',
    'it',
    'just',
    'like',
    'me',
    'my',
    'note',
    'notes',
    "n't",
    'of',
    'on',
    'or',
    'please',
    'show',
    'talk',
    'talked',
    'talking',
    'tell',
    'that',
    'the',
    'then',
    'to',
    'us',
    'was',
    'were',
    'what',
    'where',
    'which',
    'with',
    'would',
    'you'
  ]);

  const kept = tokens.filter((t) => !STOP.has(t) && t.length >= 2);

  // If stripping removes everything, fall back to the original tokens.
  const out = (kept.length ? kept : tokens).slice(0, 14).join(' ');
  return out.trim();
}

function rerankSearchResults(q, rows) {
  const qTokens = tokenizeForCompare(q);
  const qNorm = normalizeComparableText(q);
  const qBigrams = bigrams(qTokens);

  // If query is too short, re-ranking doesn't help much.
  if (qTokens.length === 0) return rows;

  const scored = rows.map((r) => {
    const title = (r?.title ?? '').toString();
    const body = (r?.body ?? '').toString();
    const docText = `${title}\n${body}`;

    const docTokens = tokenizeForCompare(docText);
    const docTokenSet = new Set(docTokens);

    let hitCount = 0;
    for (const t of qTokens) if (docTokenSet.has(t)) hitCount += 1;

    const overlap = hitCount / Math.max(1, qTokens.length); // 0..1

    const docNorm = normalizeComparableText(docText);
    const phraseHit = qNorm.length >= 6 && docNorm.includes(qNorm);

    const docBigrams = bigrams(docTokens);
    let bigramHits = 0;
    if (qBigrams.length) {
      const docBigramSet = new Set(docBigrams);
      for (const b of qBigrams) if (docBigramSet.has(b)) bigramHits += 1;
    }
    const bigramScore = qBigrams.length ? bigramHits / qBigrams.length : 0; // 0..1

    // bm25 rank: smaller is better; convert to a positive score where larger is better.
    const bm25 = Number.isFinite(Number(r?.rank)) ? Number(r.rank) : null;
    const bm25Score = bm25 === null ? 0 : 1 / (1 + Math.max(0, bm25));

    const score = 0.55 * bm25Score + 0.30 * overlap + 0.10 * bigramScore + (phraseHit ? 0.20 : 0);

    return { row: r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.row);
}

function normalizeComparableText(s) {
  return (s ?? '')
    .toString()
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('\r\n', '\n')
    .replaceAll('\n', ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replaceAll(/\s+/g, ' ');
}

function tokenizeForCompare(s) {
  const norm = normalizeComparableText(s);
  if (!norm) return [];
  return norm.split(' ').filter(Boolean);
}

function bigrams(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 1) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
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

function formatClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (hh > 0) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${String(mm).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

async function generateOpenAiAnswer(client, effectiveQuery, clips) {
  const context = (clips ?? [])
    .map(
      (c, i) =>
        `[${i + 1}] Note "${c.title}" (${c.note_id}) ${formatClock(c.start)}–${formatClock(c.end)}\n${c.text}`
    )
    .join('\n\n');

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You answer using ONLY the provided clips. If there is not enough evidence, say so. Never invent facts. Keep it concise.'
      },
      {
        role: 'user',
        content: [
          `Question: ${effectiveQuery}`,
          '',
          'Clips:',
          context,
          '',
          'Return ONLY valid JSON with this shape:',
          '{ "answer": string, "citations": number[], "insufficient_evidence": boolean }',
          'Rules:',
          '- citations must be integers referencing clips, e.g. [1,2]',
          '- answer MUST include citations like [1] inline when using evidence',
          '- if insufficient_evidence is true, citations must be []'
        ].join('\n')
      }
    ]
  });

  const raw = (completion?.choices?.[0]?.message?.content ?? '').toString().trim();
  const parsed = safeJsonParse(raw);
  const answer = (parsed?.answer ?? '').toString().trim();
  const citations = Array.isArray(parsed?.citations) ? parsed.citations : [];
  const clippedCites = citations
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= (clips?.length ?? 0));

  // Lightweight eval/guardrails: enforce at least one citation when claiming evidence.
  const insufficient = !!parsed?.insufficient_evidence;
  const hasInline = /\[\d+\]/.test(answer);
  if (!insufficient && (clippedCites.length === 0 || !hasInline)) {
    // If the model didn't comply, fall back to a safe extractive answer.
    return `I couldn’t produce a grounded answer format reliably. Here are the most relevant clips: ${clippedCites
      .slice(0, 3)
      .map((n) => `[${n}]`)
      .join(' ')}`.trim();
  }

  return answer;
}

async function generateOllamaAnswer({ host, model }, effectiveQuery, clips) {
  const base = (host ?? '').toString().trim().replace(/\/+$/, '') || 'http://127.0.0.1:11434';
  const m = (model ?? '').toString().trim();
  if (!m) throw new Error('Missing OLLAMA_MODEL');

  const context = (clips ?? [])
    .map(
      (c, i) =>
        `[${i + 1}] Note "${c.title}" (${c.note_id}) ${formatClock(c.start)}–${formatClock(c.end)}\n${c.text}`
    )
    .join('\n\n');

  const prompt = [
    `Question: ${effectiveQuery}`,
    '',
    'Clips:',
    context,
    '',
    'Return ONLY valid JSON with this shape:',
    '{ "answer": string, "citations": number[], "insufficient_evidence": boolean }',
    'Rules:',
    '- citations must be integers referencing clips, e.g. [1,2]',
    '- answer MUST include citations like [1] inline when using evidence',
    '- if insufficient_evidence is true, citations must be []'
  ].join('\n');

  const body = {
    model: m,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          'You answer using ONLY the provided clips. If there is not enough evidence, say so. Never invent facts. Keep it concise.'
      },
      { role: 'user', content: prompt }
    ],
    options: {
      temperature: 0.2
    }
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  let raw = '';
  try {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Ollama HTTP ${resp.status}${txt ? `: ${txt.slice(0, 300)}` : ''}`);
    }
    const data = await resp.json();
    raw = (data?.message?.content ?? data?.response ?? '').toString().trim();
  } finally {
    clearTimeout(t);
  }

  const parsed = safeJsonParse(raw);
  const answer = (parsed?.answer ?? '').toString().trim();
  const citations = Array.isArray(parsed?.citations) ? parsed.citations : [];
  const clippedCites = citations
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= (clips?.length ?? 0));

  const insufficient = !!parsed?.insufficient_evidence;
  const hasInline = /\[\d+\]/.test(answer);
  if (!insufficient && (clippedCites.length === 0 || !hasInline)) {
    return `I couldn’t produce a grounded answer format reliably. Here are the most relevant clips: ${clippedCites
      .slice(0, 3)
      .map((n) => `[${n}]`)
      .join(' ')}`.trim();
  }

  return answer;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    // Try to extract first JSON object if model wrapped it.
    const m = (s ?? '').toString().match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function safeStringifySegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const safe = [];
  for (const s of segments) {
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = (s?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    safe.push({
      start: Math.max(0, start),
      end: Math.max(0, end),
      text
    });
  }
  if (safe.length === 0) return '';
  try {
    return JSON.stringify(safe);
  } catch {
    return '';
  }
}

function parseSegmentsJson(segmentsJson) {
  const raw = (segmentsJson ?? '').toString().trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s) => ({
        start: Number(s?.start),
        end: Number(s?.end),
        text: (s?.text ?? '').toString()
      }))
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.text.trim().length > 0);
  } catch {
    return [];
  }
}

function parseWordsJson(wordsJson) {
  const raw = (wordsJson ?? '').toString().trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((w) => ({
        start: Number(w?.start),
        end: Number(w?.end),
        word: (w?.word ?? '').toString()
      }))
      .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start && w.word.trim());
  } catch {
    return [];
  }
}

function parseRange(rangeHeader, size) {
  // bytes=START-END
  // bytes=START-
  // bytes=-SUFFIX
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/i);
  if (!m) return { start: null, end: null };
  const startStr = m[1];
  const endStr = m[2];

  let start = startStr ? Number.parseInt(startStr, 10) : null;
  let end = endStr ? Number.parseInt(endStr, 10) : null;

  if (start === null && end === null) return { start: null, end: null };

  if (start === null) {
    // suffix length
    const suffix = end ?? 0;
    if (!Number.isFinite(suffix) || suffix <= 0) return { start: null, end: null };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (!Number.isFinite(start) || start < 0) return { start: null, end: null };
    if (end === null || !Number.isFinite(end)) end = size - 1;
    end = Math.min(end, size - 1);
  }

  if (start >= size || start > end) return { start: null, end: null };
  return { start, end };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function enqueueJob(db, { job_type, note_id, max_attempts = 3, priority = 0 } = {}) {
  try {
    const id = nanoid(12);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO ingestion_jobs (id, job_type, note_id, status, attempts, max_attempts, locked_at, available_at, priority, last_error, created_at, updated_at)
       VALUES (@id, @job_type, @note_id, @status, @attempts, @max_attempts, @locked_at, @available_at, @priority, @last_error, @created_at, @updated_at)`
    ).run({
      id,
      job_type: (job_type ?? '').toString(),
      note_id: (note_id ?? '').toString(),
      status: 'queued',
      attempts: 0,
      max_attempts,
      locked_at: '',
      available_at: '',
      priority: clampInt(priority, -5, 5, 0),
      last_error: '',
      created_at: now,
      updated_at: now
    });
    try {
      appendJobEvent(db, {
        jobId: id,
        noteId: (note_id ?? '').toString(),
        eventType: 'queued',
        message: `Job enqueued: ${(job_type ?? '').toString() || 'unknown'}`,
        meta: { priority: clampInt(priority, -5, 5, 0) }
      });
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

function appendJobEvent(db, { jobId, noteId = '', eventType, message = '', meta = null } = {}) {
  const id = nanoid(12);
  const now = new Date().toISOString();
  const job_id = (jobId ?? '').toString().trim();
  const note_id = (noteId ?? '').toString().trim();
  const event_type = (eventType ?? '').toString().trim() || 'event';
  const msg = (message ?? '').toString().slice(0, 2000);
  let meta_json = '';
  if (meta && typeof meta === 'object') {
    try {
      meta_json = JSON.stringify(meta).slice(0, 8000);
    } catch {
      meta_json = '';
    }
  }
  if (!job_id) return;
  try {
    db.prepare(
      `INSERT INTO job_events (id, job_id, note_id, event_type, message, meta_json, created_at)
       VALUES (@id, @job_id, @note_id, @event_type, @message, @meta_json, @created_at)`
    ).run({
      id,
      job_id,
      note_id,
      event_type,
      message: msg,
      meta_json,
      created_at: now
    });
  } catch {
    // ignore
  }
}

function getAppState(db, key) {
  const k = (key ?? '').toString().trim();
  if (!k) return '';
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(k);
    return (row?.value ?? '').toString();
  } catch {
    return '';
  }
}

function setAppState(db, key, value) {
  const k = (key ?? '').toString().trim();
  if (!k) return;
  const v = (value ?? '').toString();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run({ key: k, value: v, updated_at: now });
  } catch {
    // ignore
  }
}

function isIngestionPaused(db) {
  const v = getAppState(db, 'ingestion_paused');
  return v === '1' || v.toLowerCase() === 'true';
}

function getIngestionMaxParallel(db) {
  const v = getAppState(db, 'ingestion_max_parallel');
  const n = Number.parseInt((v ?? '').toString(), 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.min(6, n));
}

function startIngestionWorkerImpl(getDb, { blobsDir }) {
  const tickMs = 1200;
  let active = 0;
  const timer = setInterval(() => {
    const db = getDb?.();
    if (!db) return;
    if (isIngestionPaused(db)) return;
    // Keep queue healthy: unlock stale running jobs.
    unlockStaleJobs(db);
    const maxP = getIngestionMaxParallel(db);
    if (active >= maxP) return;
    active += 1;
    processNextJob(db, { blobsDir })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        active = Math.max(0, active - 1);
      });
  }, tickMs);
  return timer;
}

async function processNextJob(db, { blobsDir }) {
  const now = new Date().toISOString();
  if (isIngestionPaused(db)) return;

  // Acquire one queued job.
  const job = db
    .prepare(
      `SELECT j.id, j.job_type, j.note_id, j.attempts, j.max_attempts, j.available_at, j.priority
       FROM ingestion_jobs j
       LEFT JOIN note_processing_state nps ON nps.note_id = j.note_id
       WHERE j.status = 'queued'
         AND (j.available_at = '' OR j.available_at <= @now)
         AND (nps.note_id IS NULL OR nps.paused = 0)
       ORDER BY
         j.priority DESC,
         CASE WHEN j.available_at = '' THEN 0 ELSE 1 END ASC,
         j.available_at ASC,
         j.created_at ASC
       LIMIT 1`
    )
    .get({ now });
  if (!job) return;

  // Mark as running.
  db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'running', locked_at = @locked_at, available_at = '', attempts = attempts + 1, updated_at = @updated_at
     WHERE id = @id`
  ).run({ id: job.id, locked_at: now, updated_at: now });
  appendJobEvent(db, {
    jobId: job.id,
    noteId: job.note_id,
    eventType: 'running',
    message: `Job started: ${(job.job_type ?? '').toString() || 'unknown'}`,
    meta: { attempts: (Number(job.attempts ?? 0) || 0) + 1, max_attempts: Number(job.max_attempts ?? 0) || 0, priority: Number(job.priority ?? 0) || 0 }
  });

  try {
    if (job.job_type === 'transcribe_note') {
      await runTranscribeJob(db, { noteId: job.note_id, blobsDir });
    } else if (job.job_type === 'backfill_words') {
      await runBackfillWordsJob(db, { noteId: job.note_id, blobsDir });
    } else {
      throw new Error(`Unknown job_type: ${job.job_type}`);
    }

    db.prepare(
      `UPDATE ingestion_jobs SET status = 'done', updated_at = @updated_at WHERE id = @id`
    ).run({ id: job.id, updated_at: new Date().toISOString() });
    appendJobEvent(db, {
      jobId: job.id,
      noteId: job.note_id,
      eventType: 'done',
      message: 'Job completed'
    });
  } catch (e) {
    if (e?.code === 'VV_CANCEL' || e?.message === '__VV_CANCEL__') {
      const u = new Date().toISOString();
      db.prepare(
        `UPDATE ingestion_jobs
         SET status = 'cancelled', last_error = 'Stopped by user', locked_at = '', updated_at = @updated_at
         WHERE id = @id`
      ).run({ id: job.id, updated_at: u });
      appendJobEvent(db, {
        jobId: job.id,
        noteId: job.note_id,
        eventType: 'cancelled',
        message: 'Transcription stopped',
        meta: { job_type: (job.job_type ?? '').toString() }
      });
      return;
    }

    const msg = (e?.message ?? String(e)).slice(0, 2000);
    const attempts = Number(job.attempts ?? 0) + 1;
    const maxAttempts = Number(job.max_attempts ?? 3) || 3;
    const terminal = attempts >= maxAttempts;
    const nextAvailableAt = terminal ? '' : computeNextAvailableAtIso(db, { attempts });

    db.prepare(
      `UPDATE ingestion_jobs
       SET status = @status, last_error = @last_error, available_at = @available_at, locked_at = '', updated_at = @updated_at
       WHERE id = @id`
    ).run({
      id: job.id,
      status: terminal ? 'error' : 'queued',
      last_error: msg,
      available_at: nextAvailableAt,
      updated_at: new Date().toISOString()
    });
    appendJobEvent(db, {
      jobId: job.id,
      noteId: job.note_id,
      eventType: terminal ? 'error' : 'retry',
      message: terminal ? 'Job failed (terminal)' : 'Job failed (will retry)',
      meta: { attempts, max_attempts: maxAttempts, next_available_at: nextAvailableAt || '' }
    });

    // Only mark the note itself as error for primary transcription jobs.
    if (terminal && job.job_type === 'transcribe_note') {
      db.prepare(
        `UPDATE notes SET status = 'error', error = @error, updated_at = @updated_at WHERE id = @id`
      ).run({ id: job.note_id, error: msg, updated_at: new Date().toISOString() });
    }
  }
}

function unlockStaleJobs(db, { force = false } = {}) {
  const timeoutSec = clampInt(process.env.INGESTION_LOCK_TIMEOUT_SEC, 60, 24 * 60 * 60, 20 * 60);
  const cutoff = new Date(Date.now() - timeoutSec * 1000).toISOString();
  const now = new Date().toISOString();
  try {
    let stale = [];
    try {
      stale = db
        .prepare(
          `SELECT id, note_id, job_type, locked_at
           FROM ingestion_jobs
           WHERE status = 'running'
             AND locked_at != ''
             AND locked_at < @cutoff
           LIMIT 200`
        )
        .all({ cutoff });
    } catch {
      stale = [];
    }
    const r = db
      .prepare(
      `UPDATE ingestion_jobs
       SET status = 'queued',
           locked_at = '',
           available_at = @now,
           last_error = CASE
             WHEN last_error = '' THEN @msg
             ELSE substr(last_error || '\n' || @msg, 1, 2000)
           END,
           updated_at = @now
       WHERE status = 'running'
         AND locked_at != ''
         AND locked_at < @cutoff`
      )
      .run({
      now,
      cutoff,
      msg: `Unlocked stale running job (lock>${timeoutSec}s)`
    });
    const changes = Number(r?.changes ?? 0) || 0;
    if (changes > 0 && stale.length) {
      for (const s of stale) {
        appendJobEvent(db, {
          jobId: s?.id,
          noteId: s?.note_id,
          eventType: 'unlock_stale',
          message: `Unlocked stale job (lock>${timeoutSec}s)`,
          meta: { locked_at: (s?.locked_at ?? '').toString(), job_type: (s?.job_type ?? '').toString() }
        });
      }
    }
    if (changes > 0 || force) {
      setAppState(db, 'jobs_last_stale_unlock_at', now);
      setAppState(db, 'jobs_last_stale_unlock_count', String(changes));
    }
    return changes;
  } catch {
    // ignore
    return 0;
  }
}

function computeNextAvailableAtIso(db, { attempts }) {
  // attempts is 1-based at this point (we increment before running).
  // Backoff: base*2^(attempt-1) up to max (+ small jitter).
  const a = Math.max(1, Number(attempts) || 1);
  const baseMs = getBackoffBaseSec(db) * 1000;
  const maxMs = getBackoffMaxSec(db) * 1000;
  const exp = baseMs * Math.pow(2, Math.max(0, a - 1));
  const jitter = Math.floor(Math.random() * 750); // keep small, avoids herd effect
  const delayMs = Math.min(maxMs, exp) + jitter;
  return new Date(Date.now() + delayMs).toISOString();
}

function getBackoffBaseSec(db) {
  const v = getAppState(db, 'ingestion_backoff_base_sec');
  const n = Number.parseInt((v ?? '').toString(), 10);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(1, Math.min(60, n));
}

function getBackoffMaxSec(db) {
  const v = getAppState(db, 'ingestion_backoff_max_sec');
  const n = Number.parseInt((v ?? '').toString(), 10);
  if (!Number.isFinite(n) || n <= 0) return 300;
  return Math.max(5, Math.min(3600, n));
}

async function runTranscribeJob(db, { noteId, blobsDir }) {
  const row = db
    .prepare(
      `SELECT id, title, audio_blob_id, audio_mime, language
       FROM notes
       WHERE id = ?`
    )
    .get(noteId);
  if (!row) throw new Error('Note missing');
  const blobId = (row.audio_blob_id ?? '').toString().trim();
  if (!blobId) throw new Error('Missing audio_blob_id');
  const blobPath = path.join(blobsDir, blobId);
  if (!fs.existsSync(blobPath)) throw new Error('Audio blob file missing');

  const ext = mimeToExt(row.audio_mime) ?? 'webm';
  const tmpPath = path.join(audioDir, `__job_${noteId}.${ext}`);
  fs.writeFileSync(tmpPath, fs.readFileSync(blobPath));

  try {
    throwIfTranscribeCancelled(db, noteId);

    let cancelledDuringTranscribe = false;
    const pollIv = setInterval(() => {
      try {
        throwIfTranscribeCancelled(db, noteId);
      } catch (e) {
        if (e?.code === 'VV_CANCEL') cancelledDuringTranscribe = true;
      }
    }, 900);

    try {
      const out = await transcribeAudioFile(tmpPath, {
        model: process.env.WHISPER_FAST_MODEL || process.env.WHISPER_LANG_MODEL || 'tiny',
        language: (row.language ?? '').toString().trim() || process.env.WHISPER_LANGUAGE || ''
      });

      if (cancelledDuringTranscribe) {
        const e = new Error('__VV_CANCEL__');
        e.code = 'VV_CANCEL';
        throw e;
      }
      throwIfTranscribeCancelled(db, noteId);

      let transcript = formatTranscript(out?.transcript ?? '');
      const segmentsJson = safeStringifySegments(out?.segments);
      await ensureNoteSegments(db, noteId, Array.isArray(out?.segments) ? out.segments : []);
      await ensureNoteChunks(db, noteId, Array.isArray(out?.segments) ? out.segments : []);

      const updatedAt = new Date().toISOString();
      const finalTitle =
        (row.title ?? '').toString().trim() ||
        (transcript ? transcript.slice(0, 64).trim() : '') ||
        'Untitled';

      const hintLang = (row.language ?? '').toString().trim();
      const detectedLang = (out?.language ?? '').toString().trim();
      const storedLang = persistedNoteLanguage(hintLang, detectedLang);

      db.prepare(
        `UPDATE notes
         SET title = @title,
             body = @body,
             segments_json = @segments_json,
             language = @language,
             status = 'ready',
             error = '',
             updated_at = @updated_at
         WHERE id = @id AND status = 'processing'`
      ).run({
        id: noteId,
        title: finalTitle,
        body: transcript || '',
        segments_json: segmentsJson,
        language: storedLang,
        updated_at: updatedAt
      });
    } finally {
      try {
        clearInterval(pollIv);
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

async function runBackfillWordsJob(db, { noteId, blobsDir }) {
  const row = db
    .prepare(
      `SELECT id, audio_blob_id, audio_mime, language
       FROM notes
       WHERE id = ?`
    )
    .get(noteId);
  if (!row) throw new Error('Note missing');
  const blobId = (row.audio_blob_id ?? '').toString().trim();
  if (!blobId) throw new Error('Missing audio_blob_id');
  const blobPath = path.join(blobsDir, blobId);
  if (!fs.existsSync(blobPath)) throw new Error('Audio blob file missing');

  const ext = mimeToExt(row.audio_mime) ?? 'webm';
  const tmpPath = path.join(audioDir, `__words_${noteId}.${ext}`);
  fs.writeFileSync(tmpPath, fs.readFileSync(blobPath));

  try {
    const out = await transcribeAudioFile(tmpPath, {
      // Use a configurable model for backfill (default fast).
      model: process.env.WHISPER_WORDS_MODEL || process.env.WHISPER_FAST_MODEL || 'tiny',
      language: (row.language ?? '').toString().trim() || process.env.WHISPER_LANGUAGE || ''
    });

    // Important: do NOT overwrite notes.body/segments_json for older notes.
    // Only refresh the derived tables that store words.
    await ensureNoteSegments(db, noteId, Array.isArray(out?.segments) ? out.segments : []);
    await ensureNoteChunks(db, noteId, Array.isArray(out?.segments) ? out.segments : []);

    const hintLang = (row.language ?? '').toString().trim();
    const detectedLang = (out?.language ?? '').toString().trim();
    const storedLang = persistedNoteLanguage(hintLang, detectedLang);
    if (!hintLang && storedLang) {
      db.prepare(`UPDATE notes SET language = @language, updated_at = @updated_at WHERE id = @id`).run({
        id: noteId,
        language: storedLang,
        updated_at: new Date().toISOString()
      });
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function pickBestMatchSegment(q, segmentsJson) {
  const qTokens = tokenizeForCompare(q);
  if (!qTokens.length) return null;
  const qNorm = normalizeComparableText(q);
  const qTokenSet = new Set(qTokens);

  const segments = parseSegmentsJson(segmentsJson);
  if (!segments.length) return null;

  let best = null;
  let bestScore = -1;

  for (const s of segments) {
    const text = (s?.text ?? '').toString();
    const segTokens = tokenizeForCompare(text);
    if (!segTokens.length) continue;
    const segSet = new Set(segTokens);

    let hit = 0;
    for (const t of qTokenSet) if (segSet.has(t)) hit += 1;
    const overlap = hit / Math.max(1, qTokenSet.size);

    const segNorm = normalizeComparableText(text);
    const phraseHit = qNorm.length >= 5 && segNorm.includes(qNorm);

    const score = overlap + (phraseHit ? 0.35 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = {
        start: Number(s.start),
        end: Number(s.end),
        text: (s.text ?? '').toString()
      };
    }
  }

  // Require at least some overlap/phrase evidence.
  if (!best) return null;
  if (bestScore < 0.34) return null;
  if (!Number.isFinite(best.start) || !Number.isFinite(best.end) || best.end <= best.start) return null;
  return best;
}

function pickTopMatchSegments(q, segmentsJson, k = 3) {
  const qTokens = tokenizeForCompare(q);
  if (!qTokens.length) return [];
  const qNorm = normalizeComparableText(q);
  const qTokenSet = new Set(qTokens);

  const segments = parseSegmentsJson(segmentsJson);
  if (!segments.length) return [];

  const scored = [];
  for (const s of segments) {
    const text = (s?.text ?? '').toString();
    const segTokens = tokenizeForCompare(text);
    if (!segTokens.length) continue;
    const segSet = new Set(segTokens);

    let hit = 0;
    for (const t of qTokenSet) if (segSet.has(t)) hit += 1;
    const overlap = hit / Math.max(1, qTokenSet.size);

    const segNorm = normalizeComparableText(text);
    const phraseHit = qNorm.length >= 5 && segNorm.includes(qNorm);

    const score = overlap + (phraseHit ? 0.35 : 0);
    if (score < 0.34) continue;
    const start = Number(s?.start);
    const end = Number(s?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    scored.push({
      score,
      seg: { start, end, text: (s.text ?? '').toString() }
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // De-dup very close timestamps (avoid multiple nearly-identical segments).
  const out = [];
  const tol = 0.25;
  for (const item of scored) {
    if (out.length >= Math.max(1, Number(k) || 1)) break;
    const s = item.seg;
    const dup = out.some((x) => Math.abs(x.start - s.start) <= tol && Math.abs(x.end - s.end) <= tol);
    if (!dup) out.push(s);
  }
  return out;
}

function extractTimeRangeAndText(q) {
  const raw = (q ?? '').toString();
  const lower = raw.normalize('NFKC').toLowerCase();

  let from = null;
  let to = null;
  let text = raw;

  const now = new Date();

  const setRange = (a, b, removePattern) => {
    from = a;
    to = b;
    if (removePattern) {
      text = text.replace(removePattern, ' ').replaceAll(/\s+/g, ' ').trim();
    }
  };

  // between YYYY-MM-DD and YYYY-MM-DD
  {
    const m = lower.match(/\bbetween\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})\b/i);
    if (m) {
      const a = parseLocalDate(m[1]);
      const b = parseLocalDate(m[2]);
      if (a && b) {
        const start = startOfDay(a);
        const end = endOfDay(b);
        setRange(start.toISOString(), end.toISOString(), new RegExp(m[0], 'i'));
        return { text, fromIso: from, toIso: to };
      }
    }
  }

  // on YYYY-MM-DD or just YYYY-MM-DD anywhere
  {
    const m = lower.match(/\b(?:on\s+)?(\d{4}-\d{2}-\d{2})\b/i);
    if (m) {
      const d = parseLocalDate(m[1]);
      if (d) {
        const start = startOfDay(d);
        const end = endOfDay(d);
        setRange(start.toISOString(), end.toISOString(), new RegExp(m[0], 'i'));
        return { text, fromIso: from, toIso: to };
      }
    }
  }

  // today / yesterday
  if (/\btoday\b/i.test(lower)) {
    const start = startOfDay(now);
    const end = endOfDay(now);
    setRange(start.toISOString(), end.toISOString(), /\btoday\b/i);
    return { text, fromIso: from, toIso: to };
  }
  if (/\byesterday\b/i.test(lower)) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const start = startOfDay(y);
    const end = endOfDay(y);
    setRange(start.toISOString(), end.toISOString(), /\byesterday\b/i);
    return { text, fromIso: from, toIso: to };
  }

  // last N hours/days/weeks/months
  {
    const m = lower.match(/\blast\s+(\d{1,3})\s*(hour|hours|day|days|week|weeks|month|months)\b/i);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      const unit = m[2];
      if (Number.isFinite(n) && n > 0) {
        const start = new Date(now);
        if (unit.startsWith('hour')) start.setHours(start.getHours() - n);
        else if (unit.startsWith('day')) start.setDate(start.getDate() - n);
        else if (unit.startsWith('week')) start.setDate(start.getDate() - n * 7);
        else if (unit.startsWith('month')) start.setMonth(start.getMonth() - n);
        setRange(start.toISOString(), now.toISOString(), new RegExp(m[0], 'i'));
        return { text, fromIso: from, toIso: to };
      }
    }
  }

  // this week / last week
  if (/\bthis\s+week\b/i.test(lower)) {
    const start = startOfWeek(now);
    const end = endOfWeek(now);
    setRange(start.toISOString(), end.toISOString(), /\bthis\s+week\b/i);
    return { text, fromIso: from, toIso: to };
  }
  if (/\blast\s+week\b/i.test(lower)) {
    const startThis = startOfWeek(now);
    const start = new Date(startThis);
    start.setDate(start.getDate() - 7);
    const end = endOfWeek(start);
    setRange(start.toISOString(), end.toISOString(), /\blast\s+week\b/i);
    return { text, fromIso: from, toIso: to };
  }

  // this month / last month
  if (/\bthis\s+month\b/i.test(lower)) {
    const start = startOfMonth(now);
    const end = endOfMonth(now);
    setRange(start.toISOString(), end.toISOString(), /\bthis\s+month\b/i);
    return { text, fromIso: from, toIso: to };
  }
  if (/\blast\s+month\b/i.test(lower)) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    const start = startOfMonth(d);
    const end = endOfMonth(d);
    setRange(start.toISOString(), end.toISOString(), /\blast\s+month\b/i);
    return { text, fromIso: from, toIso: to };
  }

  return { text, fromIso: null, toIso: null };
}

function parseAdvancedSearchOps(db, rawQ) {
  // Parse lightweight operators from a typed query string and return:
  // - text: query string with operators stripped (used for NL rewrite/FTS)
  // - filters: applied as SQL constraints
  const out = {
    text: (rawQ ?? '').toString(),
    folder_id: '',
    tag: '',
    status: '',
    title: '',
    favorite: false,
    has_words: false,
    duration_min_ms: null,
    duration_max_ms: null
  };

  let s = out.text;

  const take = (re) => {
    const m = s.match(re);
    if (!m) return null;
    s = s.replace(m[0], ' ').replaceAll(/\s+/g, ' ').trim();
    return (m[1] ?? '').toString().trim();
  };

  // favorite:1 / favorite:true
  if (/\bfavorite:(1|true|yes)\b/i.test(s)) {
    out.favorite = true;
    s = s.replace(/\bfavorite:(1|true|yes)\b/gi, ' ').replaceAll(/\s+/g, ' ').trim();
  }

  // has:words
  if (/\bhas:words\b/i.test(s)) {
    out.has_words = true;
    s = s.replace(/\bhas:words\b/gi, ' ').replaceAll(/\s+/g, ' ').trim();
  }

  // status:ready|processing|error
  const st = take(/\bstatus:(ready|processing|error)\b/i);
  if (st) out.status = st.toLowerCase();

  // title:"foo bar" or title:foo
  const tQuoted = take(/\btitle:\"([^\"]{1,140})\"/i);
  if (tQuoted) out.title = tQuoted;
  if (!out.title) {
    const tBare = take(/\btitle:([^\s]{1,140})/i);
    if (tBare) out.title = tBare;
  }

  // tag:"foo bar" or tag:foo
  const tagQuoted = take(/\btag:\"([^\"]{1,80})\"/i);
  if (tagQuoted) out.tag = tagQuoted;
  if (!out.tag) {
    const tagBare = take(/\btag:([^\s]{1,80})/i);
    if (tagBare) out.tag = tagBare;
  }

  // folder:"Inbox" or folder:Inbox (accept id or name)
  const folderQuoted = take(/\bfolder:\"([^\"]{1,120})\"/i);
  const folderBare = folderQuoted ? '' : take(/\bfolder:([^\s]{1,120})/i);
  const folderVal = (folderQuoted || folderBare || '').trim();
  if (folderVal) {
    // If user passed an id, accept it. Otherwise, try lookup by name.
    if (/^[a-zA-Z0-9_-]{8,24}$/.test(folderVal)) {
      out.folder_id = folderVal;
    } else {
      try {
        const row = db.prepare(`SELECT id FROM folders WHERE name = ?`).get(folderVal);
        out.folder_id = (row?.id ?? '').toString();
      } catch {
        out.folder_id = '';
      }
    }
  }

  // duration:>60 (seconds), duration:<120, duration:30-90
  {
    const m = s.match(/\bduration:([<>]=?)\s*(\d{1,6})\b/i);
    if (m) {
      const op = m[1];
      const n = Number.parseInt(m[2], 10);
      if (Number.isFinite(n) && n >= 0) {
        const ms = n * 1000;
        if (op.startsWith('>')) out.duration_min_ms = ms;
        if (op.startsWith('<')) out.duration_max_ms = ms;
      }
      s = s.replace(m[0], ' ').replaceAll(/\s+/g, ' ').trim();
    } else {
      const m2 = s.match(/\bduration:(\d{1,6})\s*-\s*(\d{1,6})\b/i);
      if (m2) {
        const a = Number.parseInt(m2[1], 10);
        const b = Number.parseInt(m2[2], 10);
        if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a) {
          out.duration_min_ms = a * 1000;
          out.duration_max_ms = b * 1000;
        }
        s = s.replace(m2[0], ' ').replaceAll(/\s+/g, ' ').trim();
      }
    }
  }

  out.text = s;
  return out;
}

function parseLocalDate(isoDate) {
  const m = (isoDate ?? '').toString().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(y, mo - 1, d);
  // Guard against overflow (e.g. 2026-02-99)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d) {
  const x = startOfDay(d);
  // Monday as first day of week (0=Sun .. 6=Sat)
  const day = x.getDay();
  const delta = (day + 6) % 7;
  x.setDate(x.getDate() - delta);
  return x;
}

function endOfWeek(d) {
  const x = startOfWeek(d);
  x.setDate(x.getDate() + 6);
  return endOfDay(x);
}

function startOfMonth(d) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function endOfMonth(d) {
  const x = startOfMonth(d);
  x.setMonth(x.getMonth() + 1);
  x.setDate(0); // last day of previous month
  return endOfDay(x);
}

