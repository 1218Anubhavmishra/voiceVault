import cors from 'cors';
import './load-env.js';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'node:url';
import cookieSession from 'cookie-session';
import bcrypt from 'bcryptjs';
import { getPaths, openDb, convertSqliteFtsToPostgresTsquery } from './db.js';
import { cleanupEphemeralServerCache } from './cleanup-ephemeral.js';
import { transcribeAudioFile, warmupWhisperPipeline, writeLangProbeWavClip } from './transcribe.js';
import { normalizeSttProvider, sttProviderForAuthoritativeFinal, defaultSttProviderFromEnv } from './stt-providers.js';
import { ensureNoteChunks, ensureNoteSegments, semanticSearch } from './semantic.js';
import { embedTexts, bufferToFloat32, cosineSim } from './embeddings.js';
import OpenAI from 'openai';
import { Pinecone } from '@pinecone-database/pinecone';
const PORT = process.env.PORT ? Number(process.env.PORT) : 5177;

const SESSION_MAX_AGE_MS = (() => {
  const raw = (process.env.VOICEVAULT_SESSION_MAX_AGE_MS ?? '').toString().trim();
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return 1000 * 60 * 60 * 24 * 365 * 10; // default ~10 years; cleared only on logout
})();

/** User-visible note title (separate from stored audio filename and from FTS `title`). */
function stemFilenameForDisplayTitle(name) {
  const base = path.basename((name ?? '').toString().trim());
  if (!base) return '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim();
}

/** Indexed headline for FTS triggers: prefers display title, else transcript prefix. */
function computeFtsTitle(displayTitle, body) {
  const d = (displayTitle ?? '').toString().trim();
  if (d) return d;
  const b = (body ?? '').toString().trim().replace(/\s+/g, ' ');
  if (b) return b.slice(0, 120);
  return 'Untitled';
}

/**
 * Notes list: expose pending ingestion work so the UI can recompute "time left" from queue state
 * (instead of extending a blind +45s budget when the first audio-based guess hits zero).
 */
async function attachProcessingEtaFields(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const processingIds = [];
  for (const r of rows) {
    if ((r?.status ?? '').toString() !== 'processing') continue;
    const id = (r?.id ?? '').toString().trim();
    if (id) processingIds.push(id);
  }
  if (processingIds.length === 0) {
    return rows.map((r) => ({
      ...r,
      processing_pending_units: 0,
      processing_running_locked_at: '',
      processing_coarse_stage: ''
    }));
  }
  const uniqueIds = [...new Set(processingIds)];
  const ph = uniqueIds.map(() => '?').join(',');
  let sums = [];
  try {
    sums = await db
      .prepare(
        `SELECT note_id,
                COALESCE(SUM(
                  CASE
                    WHEN status IN ('queued', 'running') AND job_type = 'transcribe_note' THEN 100
                    WHEN status IN ('queued', 'running') AND job_type = 'backfill_words' THEN 12
                    ELSE 0
                  END
                ), 0) AS units,
                MAX(CASE WHEN status = 'running' AND locked_at != '' THEN locked_at END) AS locked_at,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_n,
                SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_n
         FROM ingestion_jobs
         WHERE note_id IN (${ph})
         GROUP BY note_id`
      )
      .all(...uniqueIds);
  } catch {
    sums = [];
  }
  const byId = new Map(sums.map((s) => [((s?.note_id ?? '') || '').toString(), s]));
  return rows.map((r) => {
    const st = (r?.status ?? '').toString();
    if (st !== 'processing') {
      return { ...r, processing_pending_units: 0, processing_running_locked_at: '', processing_coarse_stage: '' };
    }
    const id = (r?.id ?? '').toString();
    const s = byId.get(id);
    let units = Number(s?.units ?? 0) || 0;
    if (units <= 0) units = 100;
    const locked_at = ((s?.locked_at ?? '') || '').toString();
    const rn = Number(s?.running_n ?? 0) || 0;
    const qn = Number(s?.queued_n ?? 0) || 0;
    let processing_coarse_stage = 'unknown';
    if (rn > 0) processing_coarse_stage = 'running';
    else if (qn > 0) processing_coarse_stage = 'queued';
    return {
      ...r,
      processing_pending_units: units,
      processing_running_locked_at: locked_at,
      processing_coarse_stage
    };
  });
}

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json({ limit: '1mb' }));

// Top-level await: this file is an ES module, so top-level `await` is supported. The
// Postgres pool and schema migrations both run before any route handler is reached.
let db = await openDb();
const { dataDir, audioDir, blobsDir, dbPath } = getPaths();

async function getOrCreateSessionSecret(dbInst) {
  const envSecret = (process.env.VOICEVAULT_SESSION_SECRET ?? '').toString().trim();
  if (envSecret) return envSecret;
  try {
    const row = await dbInst.prepare(`SELECT value FROM app_state WHERE key = 'session_secret'`).get();
    const cur = (row?.value ?? '').toString().trim();
    if (cur) return cur;
  } catch {
    // ignore
  }
  const gen = crypto.randomBytes(32).toString('hex');
  try {
    await dbInst
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES ('session_secret', @value, @updated_at)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run({ value: gen, updated_at: new Date().toISOString() });
  } catch {
    // ignore
  }
  return gen;
}

app.use(
  cookieSession({
    name: 'vv_session',
    secret: await getOrCreateSessionSecret(db),
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // local dev / local app; set to true behind HTTPS
    maxAge: SESSION_MAX_AGE_MS
  })
);

function currentUserId(req) {
  const uid = req?.session?.user_id;
  return uid ? String(uid) : '';
}

function requireUser(req, res, next) {
  const uid = currentUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in' });
  req.user_id = uid;
  next();
}

async function redirectFirstUserIfNeeded() {
  try {
    const userCount = Number(await db.prepare(`SELECT count(1) AS c FROM users`).get()?.c ?? 0) || 0;
    if (userCount !== 1) return;
    const orphanNotes = Number(await db.prepare(`SELECT count(1) AS c FROM notes WHERE trim(user_id) = ''`).get()?.c ?? 0) || 0;
    if (orphanNotes === 0) return;
    const u = await db.prepare(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`).get();
    const uid = (u?.id ?? '').toString().trim();
    if (!uid) return;
    await db.prepare(`UPDATE notes SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    try {
      await db.prepare(`UPDATE folders SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    } catch {
      // ignore
    }
    try {
      await db.prepare(`UPDATE tags SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    } catch {
      // ignore
    }
    try {
      await db.prepare(`UPDATE saved_searches SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    } catch {
      // ignore
    }
    try {
      await db.prepare(`UPDATE note_drafts SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    } catch {
      // ignore
    }
    try {
      await db.prepare(`UPDATE note_processing_state SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    } catch {
      // ignore
    }
    try {
      await db.prepare(`UPDATE job_events SET user_id = ? WHERE trim(user_id) = ''`).run(uid);
    } catch {
      // ignore
    }
    try {
      await db.prepare(
        `UPDATE ingestion_jobs
         SET user_id = ?
         WHERE trim(user_id) = ''
           AND note_id IN (SELECT id FROM notes WHERE user_id = ?)`
      ).run(uid, uid);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

await redirectFirstUserIfNeeded();

// Protect all API routes except auth + health/debug + initial client config.
app.use('/api', (req, res, next) => {
  const p = (req.path ?? '').toString();
  if (
    p.startsWith('/auth/') ||
    p === '/auth' ||
    p.startsWith('/health') ||
    p === '/client-config'
  ) {
    return next();
  }
  return requireUser(req, res, next);
});

function debugApiAllowed() {
  return (process.env.VOICEVAULT_ENABLE_DEBUG_API ?? '').toString().trim() === '1';
}

function assertDebugApi(req, res) {
  if (!debugApiAllowed()) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return false;
  }
  return true;
}

async function countUsers() {
  try {
    return Number(await db.prepare(`SELECT count(1) AS c FROM users`).get()?.c ?? 0) || 0;
  } catch {
    return 0;
  }
}

async function allowGlobalMachineControls() {
  if ((process.env.VOICEVAULT_ALLOW_GLOBAL_CONTROLS ?? '').toString().trim() === '1') return true;
  return await countUsers() <= 1;
}

async function assertGlobalMachineControls(req, res) {
  if (await allowGlobalMachineControls()) return true;
  res.status(403).json({
    error: 'Global processing controls are disabled when multiple profiles exist',
    hint: 'Set VOICEVAULT_ALLOW_GLOBAL_CONTROLS=1 on the server to enable (machine admin only).'
  });
  return false;
}

if ((process.env.VOICEVAULT_CLEAN_EPHEMERAL ?? '1').toString().trim() !== '0') {
  try {
    const s = cleanupEphemeralServerCache({ dataDir, audioDir });
    const n = s.audio_files + s.audio_dirs + s.import_zips + s.staging_dirs;
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log('[voicevault] cleaned ephemeral cache:', s);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[voicevault] ephemeral cache cleanup failed:', e?.message ?? e);
  }
}
try {
  await pruneExpiredNoteDrafts(db, blobsDir);
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[voicevault] note draft prune failed:', e?.message ?? e);
}
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

const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024
  }
});

function userToPublicJson(row) {
  if (!row) return null;
  const hasAvatar = !!(row.avatar_blob_id ?? '').toString().trim();
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_avatar: hasAvatar
  };
}

function imageContentTypeFromBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 3) return 'application/octet-stream';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

function writeBlobIfMissing(blobId, buffer) {
  const bid = (blobId ?? '').toString().trim();
  if (!bid || !buffer?.length) return;
  const blobPath = path.join(blobsDir, bid);
  try {
    if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, buffer);
  } catch {
    // ignore; notes row still carries inline audio_blob when needed
  }
}

async function countBlobRefs(dbInst, blobId) {
  const b = (blobId ?? '').toString().trim();
  if (!b) return { notes: 999, drafts: 999, users: 999 };
  const n1 = Number(await dbInst.prepare(`SELECT count(1) AS c FROM notes WHERE audio_blob_id = ?`).get(b)?.c ?? 0) || 0;
  const n2 = Number(await dbInst.prepare(`SELECT count(1) AS c FROM note_drafts WHERE audio_blob_id = ?`).get(b)?.c ?? 0) || 0;
  let n3 = 0;
  try {
    n3 = Number(await dbInst.prepare(`SELECT count(1) AS c FROM users WHERE avatar_blob_id = ?`).get(b)?.c ?? 0) || 0;
  } catch {
    n3 = 999;
  }
  return { notes: n1, drafts: n2, users: n3 };
}

async function maybeUnlinkBlob(dbInst, blobDirPath, blobId) {
  const b = (blobId ?? '').toString().trim();
  if (!b) return;
  const { notes, drafts, users } = await countBlobRefs(dbInst, b);
  if (notes > 0 || drafts > 0 || users > 0) return;
  try {
    fs.unlinkSync(path.join(blobDirPath, b));
  } catch {
    // ignore
  }
}

async function pruneExpiredNoteDrafts(dbInst, blobDirPath) {
  const hours = Math.max(1, Number(process.env.VOICEVAULT_NOTE_DRAFT_MAX_AGE_H ?? '72') || 72);
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  let rows = [];
  try {
    rows = await dbInst.prepare(`SELECT id, audio_blob_id FROM note_drafts WHERE updated_at < ?`).all(cutoff);
  } catch {
    rows = [];
  }
  for (const r of rows) {
    const id = (r?.id ?? '').toString().trim();
    const oldBid = (r?.audio_blob_id ?? '').toString().trim();
    if (!id) continue;
    try {
      await dbInst.prepare(`DELETE FROM note_drafts WHERE id = ?`).run(id);
    } catch {
      // ignore
    }
    await maybeUnlinkBlob(dbInst, blobDirPath, oldBid);
  }
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, ingestion: { paused: await isIngestionPaused(db) } });
});

// --- Auth (local profiles) ---

app.get('/api/auth/me', async (req, res) => {
  const uid = currentUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in' });
  const row = await db
    .prepare(`SELECT id, email, display_name, avatar_blob_id, created_at, updated_at FROM users WHERE id = ?`)
    .get(uid);
  if (!row) return res.status(401).json({ error: 'Session invalid' });
  res.json({ user: userToPublicJson(row) });
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    req.session = null;
  } catch {
    // ignore
  }
  res.json({ ok: true });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/register', async (req, res) => {
  const email = (req.body?.email ?? '').toString().trim().toLowerCase();
  const password = (req.body?.password ?? '').toString();
  const displayName = (req.body?.display_name ?? '').toString().trim();
  // Per-field error codes so the UI can highlight the offending input.
  if (!email) {
    return res.status(400).json({ error: 'Email is required', code: 'missing_email', field: 'email' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address', code: 'invalid_email', field: 'email' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Password is required', code: 'missing_password', field: 'password' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password is too short (min 6 characters)', code: 'password_too_short', field: 'password' });
  }

  const id = nanoid(12);
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, 10);
  try {
    await db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, avatar_blob_id, created_at, updated_at)
       VALUES (@id, @email, @password_hash, @display_name, @avatar_blob_id, @created_at, @updated_at)`
    ).run({
      id,
      email,
      password_hash: hash,
      display_name: displayName,
      avatar_blob_id: '',
      created_at: now,
      updated_at: now
    });
  } catch (e) {
    const msg = (e?.message ?? '').toString();
    // Postgres unique-violation is SQLSTATE 23505; match by code or message text.
    if (e?.code === '23505' || msg.includes('UNIQUE') || msg.toLowerCase().includes('idx_users_email')) {
      return res.status(409).json({ error: 'An account with this email already exists', code: 'email_exists', field: 'email' });
    }
    return res.status(500).json({ error: 'Register failed', details: e?.message ?? String(e) });
  }

  try {
    req.session.user_id = id;
  } catch {
    // ignore
  }
  await redirectFirstUserIfNeeded();
  const user = await db.prepare(`SELECT id, email, display_name, avatar_blob_id, created_at, updated_at FROM users WHERE id = ?`).get(id);
  res.status(201).json({ ok: true, user: userToPublicJson(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = (req.body?.email ?? '').toString().trim().toLowerCase();
  const password = (req.body?.password ?? '').toString();
  if (!email) {
    return res.status(400).json({ error: 'Email is required', code: 'missing_email', field: 'email' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Password is required', code: 'missing_password', field: 'password' });
  }

  const row = await db
    .prepare(`SELECT id, email, password_hash, display_name, avatar_blob_id, created_at, updated_at FROM users WHERE email = ?`)
    .get(email);
  // Tell the user explicitly when no profile exists for that email so the UI can
  // highlight the email field instead of generically saying "invalid credentials".
  if (!row || !row.password_hash || row.password_hash === '!') {
    return res
      .status(404)
      .json({ error: 'No account found with that email', code: 'email_not_found', field: 'email' });
  }
  const ok = bcrypt.compareSync(password, row.password_hash);
  if (!ok) {
    return res
      .status(401)
      .json({ error: 'Incorrect password', code: 'wrong_password', field: 'password' });
  }

  try {
    req.session.user_id = row.id;
  } catch {
    // ignore
  }
  await redirectFirstUserIfNeeded();
  const { password_hash: _ph, ...rest } = row;
  res.json({ ok: true, user: userToPublicJson(rest) });
});

app.patch('/api/auth/profile', async (req, res) => {
  const uid = currentUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in' });
  const displayName = (req.body?.display_name ?? '').toString().trim();
  const newEmail = (req.body?.email ?? '').toString().trim().toLowerCase();
  const newPassword = (req.body?.password ?? '').toString();
  const curPass = (req.body?.current_password ?? '').toString();

  const row = await db.prepare(`SELECT id, email, password_hash FROM users WHERE id = ?`).get(uid);
  if (!row) return res.status(401).json({ error: 'Session invalid' });

  const parts = [];
  const params = { id: uid, updated_at: new Date().toISOString() };

  if (displayName !== undefined && displayName !== null) {
    parts.push(`display_name = @display_name`);
    params.display_name = displayName;
  }

  const wantsEmailChange = newEmail && newEmail !== (row.email ?? '').toString().toLowerCase();
  const wantsPassChange = newPassword && newPassword.length > 0;

  if (wantsEmailChange || wantsPassChange) {
    if (!curPass) return res.status(400).json({ error: 'Current password required' });
    const okCur = bcrypt.compareSync(curPass, row.password_hash);
    if (!okCur) return res.status(401).json({ error: 'Invalid current password' });
  }

  if (wantsEmailChange) {
    parts.push(`email = @email`);
    params.email = newEmail;
  }

  if (wantsPassChange) {
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
    parts.push(`password_hash = @password_hash`);
    params.password_hash = bcrypt.hashSync(newPassword, 10);
  }

  if (!parts.length) return res.status(400).json({ error: 'Nothing to update' });

  parts.push(`updated_at = @updated_at`);
  try {
    await db.prepare(`UPDATE users SET ${parts.join(', ')} WHERE id = @id`).run(params);
  } catch (e) {
    const msg = (e?.message ?? '').toString();
    if (msg.includes('UNIQUE') || msg.toLowerCase().includes('idx_users_email')) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    return res.status(500).json({ error: 'Update failed', details: e?.message ?? String(e) });
  }

  const user = await db.prepare(`SELECT id, email, display_name, avatar_blob_id, created_at, updated_at FROM users WHERE id = ?`).get(uid);
  res.json({ ok: true, user: userToPublicJson(user) });
});

app.get('/api/auth/avatar', async (req, res) => {
  const uid = currentUserId(req);
  if (!uid) return res.status(401).end();
  const row = await db.prepare(`SELECT avatar_blob_id FROM users WHERE id = ?`).get(uid);
  const bid = (row?.avatar_blob_id ?? '').toString().trim();
  if (!bid || !/^[a-f0-9]{64}$/i.test(bid)) return res.status(404).end();
  const p = path.join(blobsDir, bid);
  if (!fs.existsSync(p)) return res.status(404).end();
  try {
    const buf = fs.readFileSync(p);
    const ct = imageContentTypeFromBuffer(buf);
    res.setHeader('Content-Type', ct.startsWith('image/') ? ct : 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.end(buf);
  } catch {
    return res.status(404).end();
  }
});

app.post('/api/auth/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  const uid = currentUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in' });
  const buf = req.file?.buffer;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'Missing image' });
  const ct = imageContentTypeFromBuffer(buf);
  if (!ct.startsWith('image/')) return res.status(400).json({ error: 'File must be an image (JPEG, PNG, GIF, or WebP)' });
  const blobId = crypto.createHash('sha256').update(buf).digest('hex');
  writeBlobIfMissing(blobId, buf);
  const prev = await db.prepare(`SELECT avatar_blob_id FROM users WHERE id = ?`).get(uid);
  const oldBid = (prev?.avatar_blob_id ?? '').toString().trim();
  const now = new Date().toISOString();
  await db.prepare(`UPDATE users SET avatar_blob_id = @bid, updated_at = @u WHERE id = @id`).run({ bid: blobId, u: now, id: uid });
  if (oldBid && oldBid !== blobId) await maybeUnlinkBlob(db, blobsDir, oldBid);
  return res.json({ ok: true, has_avatar: true });
});

app.delete('/api/auth/avatar', async (req, res) => {
  const uid = currentUserId(req);
  if (!uid) return res.status(401).json({ error: 'Not logged in' });
  const row = await db.prepare(`SELECT avatar_blob_id FROM users WHERE id = ?`).get(uid);
  const oldBid = (row?.avatar_blob_id ?? '').toString().trim();
  const now = new Date().toISOString();
  await db.prepare(`UPDATE users SET avatar_blob_id = '', updated_at = ? WHERE id = ?`).run(now, uid);
  if (oldBid) await maybeUnlinkBlob(db, blobsDir, oldBid);
  return res.json({ ok: true, has_avatar: false });
});

app.get('/api/debug/paths', async (_req, res) => {
  if (!assertDebugApi(_req, res)) return;
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

/** Non-secret UI hints (e.g. default STT provider from env). */
app.get('/api/client-config', async (_req, res) => {
  res.json({ stt_provider: defaultSttProviderFromEnv() });
});

app.get('/api/debug/embeddings', async (_req, res) => {
  if (!assertDebugApi(_req, res)) return;
  try {
    const chunks = Number(await db.prepare(`SELECT count(1) AS c FROM note_chunks`).get()?.c ?? 0) || 0;
    const embedded =
      Number(
        await db
          .prepare(`SELECT count(1) AS c FROM note_chunks WHERE embedding IS NOT NULL AND length(embedding) > 0`)
          .get()?.c ?? 0
      ) || 0;
    res.json({ ok: true, chunks, embedded });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.get('/api/debug/semantic-score', async (req, res) => {
  if (!assertDebugApi(req, res)) return;
  const q = (req.query.q ?? 'recording').toString().trim();
  try {
    const [qVec] = await embedTexts([q]);
    const row = await db
      .prepare(
        `SELECT nc.note_id, nc.chunk_idx, nc.text, nc.embedding
         FROM note_chunks nc
         JOIN notes n ON n.id = nc.note_id
         WHERE n.user_id = ?
         LIMIT 1`
      )
      .get(req.user_id);
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
  if (!assertDebugApi(req, res)) return;
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
  if (!assertDebugApi(req, res)) return;
  const q = (req.body?.q ?? 'recording').toString().trim();
  try {
    const out = await semanticSearch(db, { query: q, topK: 10, filters: { user_id: req.user_id } });
    const embedded =
      Number(
        await db
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
 * Re-run STT to fill `notes.language` where it is empty (ElevenLabs STT).
 * Body: { limit?: number, dry_run?: boolean, language_hint?: string } — hint is passed to transcribe (empty = auto-detect).
 */
app.post('/api/debug/backfill-note-languages', async (req, res) => {
  if (!assertDebugApi(req, res)) return;
  const limit = clampInt(req.body?.limit, 1, 500, 25);
  const dryRun = !!(req.body?.dry_run ?? false);
  const languageHint = (req.body?.language_hint ?? '').toString().trim();

  try {
    const rows = await db
      .prepare(
        `SELECT id, audio_blob_id, audio_mime, language
         FROM notes
         WHERE user_id = ?
           AND (language IS NULL OR trim(language) = '')
           AND status = 'ready'
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(req.user_id, limit);

    if (dryRun) {
      return res.json({
        ok: true,
        dry_run: true,
        count: rows.length,
        ids: rows.map((r) => r.id)
      });
    }

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
          language: languageHint || ''
        });
        const detected = (out?.language ?? '').toString().trim();
        const hint = (row.language ?? '').toString().trim();
        const finalLang = persistedNoteLanguage(hint, detected);
        if (finalLang) {
          const updatedAt = new Date().toISOString();
          await db.prepare(`UPDATE notes SET language = @language, updated_at = @updated_at WHERE id = @id AND user_id = @user_id`).run({
            id: noteId,
            user_id: req.user_id,
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

// NOTE: /api/export.zip and /api/import previously did a SQLite-file + blob-dir
// swap to back up and restore the entire instance. With a managed Postgres
// backend (and audio bytes stored in BYTEA columns), that approach is no longer
// meaningful: there is no on-disk SQLite file to copy, the database is owned by
// the hosting provider, and a process-level file swap cannot replace a remote
// Postgres dataset. They are retired with HTTP 410 (Gone). Operators should use
// `pg_dump` / `pg_restore` (or the provider-managed snapshot/PITR feature) for
// full-database backup and restore.

app.get('/api/export.zip', (_req, res) => {
  res.status(410).json({
    error: 'Endpoint removed',
    code: 'export_zip_removed',
    message:
      'The /api/export.zip endpoint was tied to the legacy SQLite + on-disk-blobs storage layout. ' +
      'voiceVault now uses PostgreSQL with audio stored in BYTEA columns, so there is no SQLite file ' +
      'or blobs directory to bundle.',
    recommendation:
      'For full-database backups, run `pg_dump` against your DATABASE_URL (or use your Postgres provider\'s ' +
      'managed snapshot / point-in-time-recovery feature). Run-of-the-mill data export/migration can be done ' +
      'with the same migration helper used in scripts/migrate-sqlite-to-pg.js.'
  });
});

app.post('/api/import', (_req, res) => {
  res.status(410).json({
    error: 'Endpoint removed',
    code: 'import_zip_removed',
    message:
      'The /api/import endpoint previously swapped SQLite + blob files in place. That flow cannot work ' +
      'against a managed Postgres database, so it has been retired.',
    recommendation:
      'Restore from a `pg_dump` archive with `pg_restore` (or `psql`) directly against your DATABASE_URL, ' +
      'or re-run scripts/migrate-sqlite-to-pg.js if you are migrating from a local SQLite snapshot.'
  });
});

app.get('/api/ingestion', async (_req, res) => {
  res.json({ paused: await isIngestionPaused(db) });
});

app.post('/api/ingestion/pause', async (req, res) => {
  if (!await assertGlobalMachineControls(req, res)) return;
  await setAppState(db, 'ingestion_paused', '1');
  res.json({ ok: true, paused: true });
});

app.post('/api/ingestion/resume', async (req, res) => {
  if (!await assertGlobalMachineControls(req, res)) return;
  await setAppState(db, 'ingestion_paused', '0');
  res.json({ ok: true, paused: false });
});

app.get('/api/jobs', async (req, res) => {
  const uid = req.user_id;
  const status = (req.query.status ?? '').toString().trim();
  const limit = clampInt(req.query.limit, 1, 200, 40);
  const whereParts = [`n.user_id = ?`];
  const args = [uid];
  if (status) {
    whereParts.push(`j.status = ?`);
    args.push(status);
  }
  const whereSql = `WHERE ${whereParts.join(' AND ')}`;
  const rows = await db
    .prepare(
      `SELECT j.id, j.job_type, j.note_id, j.status, j.attempts, j.max_attempts, j.locked_at, j.last_error, j.created_at, j.updated_at,
              j.available_at,
              COALESCE(NULLIF(trim(n.display_title), ''), n.title) AS note_title, n.status AS note_status
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
       ${whereSql}
       ORDER BY j.updated_at DESC
       LIMIT ?`
    )
    .all(...args, limit);
  res.json({ paused: await isIngestionPaused(db), items: rows });
});

app.get('/api/jobs/:id/events', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const limit = clampInt(req.query.limit, 1, 500, 200);
  try {
    const owns = await db
      .prepare(
        `SELECT 1 AS ok
         FROM ingestion_jobs j
         JOIN notes n ON n.id = j.note_id
         WHERE j.id = ? AND n.user_id = ?
         LIMIT 1`
      )
      .get(id, req.user_id);
    if (!owns) return res.status(404).json({ ok: false, error: 'Not found' });
    const items = await db
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

app.get('/api/processes/summary', async (req, res) => {
  const paused = await isIngestionPaused(db);
  const maxParallel = await getIngestionMaxParallel(db);
  const now = new Date().toISOString();
  const counts = await db
    .prepare(
      `SELECT j.status, count(1) AS c
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
       WHERE n.user_id = ?
       GROUP BY j.status`
    )
    .all(req.user_id);
  const byStatus = {};
  for (const r of counts) byStatus[(r?.status ?? '').toString()] = Number(r?.c ?? 0) || 0;

  const notes = await db
    .prepare(
      `SELECT status, count(1) AS c
       FROM notes
       WHERE user_id = ?
       GROUP BY status`
    )
    .all(req.user_id);
  const notesByStatus = {};
  for (const r of notes) notesByStatus[(r?.status ?? '').toString()] = Number(r?.c ?? 0) || 0;

  let delayedQueued = 0;
  try {
    const row = await db
      .prepare(
        `SELECT count(1) AS c
         FROM ingestion_jobs j
         JOIN notes n ON n.id = j.note_id
         WHERE j.status = 'queued'
           AND j.available_at != ''
           AND j.available_at > ?
           AND n.user_id = ?`
      )
      .get(now, req.user_id);
    delayedQueued = Number(row?.c ?? 0) || 0;
  } catch {
    delayedQueued = 0;
  }

  const recentErrors = await db
    .prepare(
      `SELECT id, title, substr(error, 1, 240) AS error, updated_at
       FROM notes
       WHERE status = 'error' AND user_id = ?
       ORDER BY updated_at DESC
       LIMIT 10`
    )
    .all(req.user_id);

  res.json({
    paused,
    max_parallel: maxParallel,
    jobs: byStatus,
    jobs_delayed_queued: delayedQueued,
    jobs_last_stale_unlock_at: await getAppState(db, 'jobs_last_stale_unlock_at') || '',
    jobs_last_stale_unlock_count: Number(await getAppState(db, 'jobs_last_stale_unlock_count') || 0) || 0,
    backoff_base_sec: await getBackoffBaseSec(db),
    backoff_max_sec: await getBackoffMaxSec(db),
    notes: notesByStatus,
    error_notes: recentErrors
  });
});

app.post('/api/processes/max-parallel', async (req, res) => {
  if (!await assertGlobalMachineControls(req, res)) return;
  const n = clampInt(req.body?.max_parallel, 1, 6, 1);
  await setAppState(db, 'ingestion_max_parallel', String(n));
  res.json({ ok: true, max_parallel: n });
});

app.post('/api/processes/backoff', async (req, res) => {
  if (!await assertGlobalMachineControls(req, res)) return;
  const base = clampInt(req.body?.base_sec, 1, 60, 5);
  const max = clampInt(req.body?.max_sec, 5, 3600, 300);
  await setAppState(db, 'ingestion_backoff_base_sec', String(base));
  await setAppState(db, 'ingestion_backoff_max_sec', String(max));
  res.json({ ok: true, backoff_base_sec: base, backoff_max_sec: max });
});

app.post('/api/processes/retry-all-errors', async (req, res) => {
  const now2 = new Date().toISOString();
  let changed = 0;
  try {
    let ids = [];
    try {
      ids = await db
        .prepare(
          `SELECT j.id, j.note_id, j.job_type
           FROM ingestion_jobs j
           JOIN notes n ON n.id = j.note_id
           WHERE j.status = 'error' AND n.user_id = ?
           LIMIT 500`
        )
        .all(req.user_id);
    } catch {
      ids = [];
    }
    const r = await db
      .prepare(
        `UPDATE ingestion_jobs
         SET status = 'queued',
             attempts = 0,
             locked_at = '',
             available_at = '',
             last_error = '',
             updated_at = @now
         WHERE status = 'error'
           AND note_id IN (SELECT id FROM notes WHERE user_id = @user_id)`
      )
      .run({ now: now2, user_id: req.user_id });
    changed = Number(r?.changes ?? 0) || 0;
    if (changed > 0 && ids.length) {
      for (const j of ids) {
        await appendJobEvent(db, {
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

app.post('/api/processes/unlock-stale', async (req, res) => {
  const count = await unlockStaleJobs(db, { force: true, userId: req.user_id });
  res.json({ ok: true, unlocked: count });
});

// --- Library metadata: folders/tags (local-only) ---

app.get('/api/folders', async (req, res) => {
  const items = await db
    .prepare(`SELECT id, name, created_at, updated_at FROM folders WHERE user_id = ? ORDER BY name ASC`)
    .all(req.user_id);
  res.json({ items });
});

app.post('/api/folders', async (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO folders (id, user_id, name, created_at, updated_at)
       VALUES (@id, @user_id, @name, @created_at, @updated_at)`
    ).run({ id, user_id: req.user_id, name, created_at: now, updated_at: now });
    res.status(201).json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Folder already exists', details: e?.message ?? String(e) });
  }
});

app.patch('/api/folders/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  const name = (req.body?.name ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const now = new Date().toISOString();
  try {
    const r = await db
      .prepare(`UPDATE folders SET name = @name, updated_at = @updated_at WHERE id = @id AND user_id = @user_id`)
      .run({ id, user_id: req.user_id, name, updated_at: now });
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Folder already exists', details: e?.message ?? String(e) });
  }
});

app.delete('/api/folders/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const now = new Date().toISOString();
  try {
    await db.prepare(`UPDATE notes SET folder_id = '', updated_at = @updated_at WHERE folder_id = @id AND user_id = @user_id`).run({
      id,
      user_id: req.user_id,
      updated_at: now
    });
    const r = await db.prepare(`DELETE FROM folders WHERE id = ? AND user_id = ?`).run(id, req.user_id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e?.message ?? String(e) });
  }
});

app.get('/api/tags', async (req, res) => {
  const items = await db
    .prepare(`SELECT id, name, created_at, updated_at FROM tags WHERE user_id = ? ORDER BY name ASC`)
    .all(req.user_id);
  res.json({ items });
});

app.post('/api/tags', async (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(`INSERT INTO tags (id, user_id, name, created_at, updated_at) VALUES (@id,@user_id,@name,@created_at,@updated_at)`)
      .run({
        id,
        user_id: req.user_id,
        name,
        created_at: now,
        updated_at: now
      });
    res.status(201).json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Tag already exists', details: e?.message ?? String(e) });
  }
});

app.patch('/api/tags/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  const name = (req.body?.name ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const now = new Date().toISOString();
  try {
    const r = await db
      .prepare(`UPDATE tags SET name = @name, updated_at = @updated_at WHERE id = @id AND user_id = @user_id`)
      .run({
        id,
        user_id: req.user_id,
        name,
        updated_at: now
      });
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id, name });
  } catch (e) {
    res.status(409).json({ error: 'Tag already exists', details: e?.message ?? String(e) });
  }
});

app.delete('/api/tags/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    await db.prepare(`DELETE FROM note_tags WHERE tag_id = ?`).run(id);
    const r = await db.prepare(`DELETE FROM tags WHERE id = ? AND user_id = ?`).run(id, req.user_id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e?.message ?? String(e) });
  }
});

app.get('/api/notes/:id/tags', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const owns = await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(id, req.user_id);
  if (!owns) return res.status(404).json({ error: 'Not found' });
  const items = await db
    .prepare(
      `SELECT t.id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ? AND t.user_id = ?
       ORDER BY t.name ASC`
    )
    .all(id, req.user_id);
  res.json({ note_id: id, items });
});

app.post('/api/notes/:id/tags', async (req, res) => {
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
    const owns = await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(noteId, req.user_id);
    if (!owns) return res.status(404).json({ error: 'Not found' });
    await db.prepare(`DELETE FROM note_tags WHERE note_id = ?`).run(noteId);
    for (const name of cleaned) {
      let row = await db.prepare(`SELECT id FROM tags WHERE name = ? AND user_id = ?`).get(name, req.user_id);
      if (!row) {
        const id = nanoid(12);
        try {
          await db
            .prepare(`INSERT INTO tags (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`)
            .run(id, req.user_id, name, now, now);
          row = { id };
        } catch {
          row = await db.prepare(`SELECT id FROM tags WHERE name = ? AND user_id = ?`).get(name, req.user_id);
        }
      }
      const tagId = (row?.id ?? '').toString();
      if (!tagId) continue;
      try {
        await db.prepare(`INSERT INTO note_tags (note_id, tag_id, created_at) VALUES (?,?,?) ON CONFLICT (note_id, tag_id) DO NOTHING`).run(
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

app.get('/api/saved-searches', async (req, res) => {
  const items = await db
    .prepare(`SELECT id, name, query, created_at, updated_at FROM saved_searches WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(req.user_id);
  res.json({ items });
});

app.post('/api/saved-searches', async (req, res) => {
  const name = (req.body?.name ?? '').toString().trim();
  const query = (req.body?.query ?? '').toString().trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (!query) return res.status(400).json({ error: 'Missing query' });
  const id = nanoid(12);
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO saved_searches (id, user_id, name, query, created_at, updated_at)
       VALUES (@id, @user_id, @name, @query, @created_at, @updated_at)`
    ).run({ id, user_id: req.user_id, name, query, created_at: now, updated_at: now });
    res.status(201).json({ ok: true, id, name, query });
  } catch (e) {
    res.status(500).json({ error: 'Create failed', details: e?.message ?? String(e) });
  }
});

app.patch('/api/saved-searches/:id', async (req, res) => {
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
    const r = await db
      .prepare(`UPDATE saved_searches SET ${parts.join(', ')} WHERE id = @id AND user_id = @user_id`)
      .run({ id, user_id: req.user_id, name, query, updated_at: now });
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Update failed', details: e?.message ?? String(e) });
  }
});

app.delete('/api/saved-searches/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const r = await db.prepare(`DELETE FROM saved_searches WHERE id = ? AND user_id = ?`).run(id, req.user_id);
    if (!r.changes) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed', details: e?.message ?? String(e) });
  }
});

// --- Per-note processing controls (local-only) ---

app.post('/api/notes/:id/pause-processing', async (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const now = new Date().toISOString();
  try {
    const owns = await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(noteId, req.user_id);
    if (!owns) return res.status(404).json({ error: 'Not found' });
    await db.prepare(
      `INSERT INTO note_processing_state (note_id, user_id, paused, updated_at)
       VALUES (@note_id, @user_id, 1, @updated_at)
       ON CONFLICT(note_id) DO UPDATE SET user_id = excluded.user_id, paused = 1, updated_at = excluded.updated_at`
    ).run({ note_id: noteId, user_id: req.user_id, updated_at: now });
    res.json({ ok: true, note_id: noteId, paused: true });
  } catch (e) {
    res.status(500).json({ error: 'Pause failed', details: e?.message ?? String(e) });
  }
});

app.post('/api/notes/:id/resume-processing', async (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const now = new Date().toISOString();
  try {
    const owns = await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(noteId, req.user_id);
    if (!owns) return res.status(404).json({ error: 'Not found' });
    await db.prepare(
      `INSERT INTO note_processing_state (note_id, user_id, paused, updated_at)
       VALUES (@note_id, @user_id, 0, @updated_at)
       ON CONFLICT(note_id) DO UPDATE SET user_id = excluded.user_id, paused = 0, updated_at = excluded.updated_at`
    ).run({ note_id: noteId, user_id: req.user_id, updated_at: now });
    res.json({ ok: true, note_id: noteId, paused: false });
  } catch (e) {
    res.status(500).json({ error: 'Resume failed', details: e?.message ?? String(e) });
  }
});

async function requestStopNoteJobs(db, noteId, userId) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO note_processing_state (note_id, user_id, paused, cancel_requested, updated_at)
     VALUES (@note_id, @user_id, 0, 1, @updated_at)
     ON CONFLICT(note_id) DO UPDATE SET user_id = excluded.user_id, cancel_requested = 1, updated_at = excluded.updated_at`
  ).run({ note_id: noteId, user_id: userId, updated_at: now });
  await db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'cancelled', last_error = 'Stopped', updated_at = @updated_at
     WHERE note_id = @note_id
       AND status = 'queued'
       AND EXISTS (SELECT 1 FROM notes n WHERE n.id = @note_id AND n.user_id = @user_id)`
  ).run({ note_id: noteId, user_id: userId, updated_at: now });

  const running = await db
    .prepare(
      `SELECT j.id
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
       WHERE j.note_id = ?
         AND j.status = 'running'
         AND n.user_id = ?`
    )
    .get(noteId, userId);
  if (!running) {
    await db.prepare(
      `UPDATE notes SET status = 'error', error = @error, updated_at = @updated_at WHERE id = @id AND user_id = @user_id AND status = 'processing'`
    ).run({
      id: noteId,
      user_id: userId,
      error: 'Stopped by user',
      updated_at: now
    });
    await db.prepare(`UPDATE note_processing_state SET cancel_requested = 0, updated_at = @updated_at WHERE note_id = @note_id`).run({
      note_id: noteId,
      updated_at: now
    });
  }
}

async function consumeCancelIfRequested(db, noteId) {
  const row = await db
    .prepare(
      `SELECT COALESCE(nps.cancel_requested, 0) AS c, n.user_id AS user_id
       FROM note_processing_state nps
       JOIN notes n ON n.id = nps.note_id
       WHERE nps.note_id = ?`
    )
    .get(noteId);
  if (Number(row?.c ?? 0) !== 1) return false;
  const userId = (row?.user_id ?? '').toString().trim();
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE notes SET status = 'error', error = @error, updated_at = @updated_at WHERE id = @id AND user_id = @user_id AND status = 'processing'`
  ).run({
    id: noteId,
    user_id: userId,
    error: 'Stopped by user',
    updated_at: now
  });
  await db.prepare(`UPDATE note_processing_state SET cancel_requested = 0, updated_at = @updated_at WHERE note_id = @note_id`).run({
    note_id: noteId,
    updated_at: now
  });
  return true;
}

async function throwIfTranscribeCancelled(db, noteId) {
  if (await consumeCancelIfRequested(db, noteId)) {
    const e = new Error('__VV_CANCEL__');
    e.code = 'VV_CANCEL';
    throw e;
  }
}

/** Inline /retry has no running ingestion job: stop may set the note to `error` while clearing cancel — still must abort. */
async function throwIfRetryInlineCancelled(db, noteId) {
  const row = await db.prepare(`SELECT status FROM notes WHERE id = ?`).get(noteId);
  if (!row || (row.status ?? '').toString() !== 'processing') {
    const e = new Error('__VV_CANCEL__');
    e.code = 'VV_CANCEL';
    throw e;
  }
  await throwIfTranscribeCancelled(db, noteId);
}

app.post('/api/notes/:id/stop-processing', async (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  try {
    const owns = await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(noteId, req.user_id);
    if (!owns) return res.status(404).json({ error: 'Not found' });
    await requestStopNoteJobs(db, noteId, req.user_id);
    res.json({ ok: true, note_id: noteId });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/processing/stop-all', async (req, res) => {
  try {
    const rows = await db
      .prepare(`SELECT id FROM notes WHERE status = 'processing' AND user_id = ?`)
      .all(req.user_id);
    for (const r of rows) {
      const id = (r?.id ?? '').toString().trim();
      if (id) await requestStopNoteJobs(db, id, req.user_id);
    }
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

app.post('/api/notes/:id/priority', async (req, res) => {
  const noteId = (req.params?.id ?? '').toString().trim();
  if (!noteId) return res.status(400).json({ error: 'Missing id' });
  const p = clampInt(req.body?.priority, -5, 5, 0);
  const now = new Date().toISOString();
  try {
    const owns = await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(noteId, req.user_id);
    if (!owns) return res.status(404).json({ error: 'Not found' });
    await db.prepare(
      `UPDATE ingestion_jobs
       SET priority = @priority, updated_at = @updated_at
       WHERE note_id = @note_id
         AND status = 'queued'
         AND EXISTS (SELECT 1 FROM notes n WHERE n.id = @note_id AND n.user_id = @user_id)`
    ).run({ note_id: noteId, user_id: req.user_id, priority: p, updated_at: now });
    res.json({ ok: true, note_id: noteId, priority: p });
  } catch (e) {
    res.status(500).json({ error: 'Priority update failed', details: e?.message ?? String(e) });
  }
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const job = await db
    .prepare(
      `SELECT j.id, j.note_id, j.job_type, j.status
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
       WHERE j.id = ? AND n.user_id = ?`
    )
    .get(id, req.user_id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const st = (job?.status ?? '').toString();
  if (st === 'running') return res.status(409).json({ error: 'Job is running; pause processing first' });

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'cancelled', last_error = 'Cancelled', updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, updated_at: now });
  await appendJobEvent(db, {
    jobId: id,
    noteId: (job?.note_id ?? '').toString(),
    eventType: 'cancelled',
    message: 'Job cancelled',
    meta: { job_type: (job?.job_type ?? '').toString() }
  });
  res.json({ ok: true, id, status: 'cancelled' });
});

async function removeIngestionJobRow(res, idRaw, userId) {
  const id = (idRaw ?? '').toString().trim();
  if (!id) {
    res.status(400).json({ error: 'Missing id' });
    return;
  }
  const job = await db
    .prepare(
      `SELECT j.id, j.status, j.note_id
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
       WHERE j.id = ? AND n.user_id = ?`
    )
    .get(id, userId);
  if (!job) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const st = (job?.status ?? '').toString();
  if (st === 'running') {
    res.status(409).json({ error: 'Job is running; pause processing or wait until it finishes' });
    return;
  }

  const noteId = (job?.note_id ?? '').toString().trim();
  const noteStillExists = noteId ? !!await db.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`).get(noteId, userId) : false;

  if (noteStillExists) {
    await deleteNoteCascade(noteId, userId);
    res.json({ ok: true, id, note_id: noteId, note_deleted: true });
    return;
  }

  await db.tx(async (txDb) => {
    await txDb.prepare(`DELETE FROM job_events WHERE job_id = ?`).run(id);
    await txDb.prepare(`DELETE FROM ingestion_jobs WHERE id = ?`).run(id);
  });

  res.json({ ok: true, id, note_deleted: false });
}

app.delete('/api/jobs/:id', async (req, res) => {
  await removeIngestionJobRow(res, req.params?.id, req.user_id);
});

/** Same as DELETE — some proxies strip DELETE; UI uses POST for reliability. */
app.post('/api/jobs/:id/remove', async (req, res) => {
  await removeIngestionJobRow(res, req.params?.id, req.user_id);
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const job = await db
    .prepare(
      `SELECT j.id, j.note_id, j.job_type
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
       WHERE j.id = ? AND n.user_id = ?`
    )
    .get(id, req.user_id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'queued', attempts = 0, locked_at = '', last_error = '', updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, updated_at: now });
  await appendJobEvent(db, {
    jobId: id,
    noteId: (job?.note_id ?? '').toString(),
    userId: req.user_id,
    eventType: 'manual_retry',
    message: 'Job manually re-queued',
    meta: { job_type: (job?.job_type ?? '').toString() }
  });
  res.json({ ok: true, id, status: 'queued' });
});

app.post('/api/note-drafts', upload.single('audio'), async (req, res) => {
  try {
    const audio = req.file;
    if (!audio?.buffer?.length) return res.status(400).json({ error: 'Missing audio file' });
    const id = nanoid(12);
    const blobId = sha256Hex(audio.buffer);
    writeBlobIfMissing(blobId, audio.buffer);
    const now = new Date().toISOString();
    const dm = clampInt(req.body?.duration_ms, 0, 24 * 60 * 60 * 1000, 0);
    await db.prepare(
      `INSERT INTO note_drafts (id, user_id, audio_blob_id, audio_mime, audio_bytes, duration_ms, created_at, updated_at)
       VALUES (@id, @user_id, @audio_blob_id, @audio_mime, @audio_bytes, @duration_ms, @created_at, @updated_at)`
    ).run({
      id,
      user_id: req.user_id,
      audio_blob_id: blobId,
      audio_mime: audio.mimetype || 'application/octet-stream',
      audio_bytes: audio.size,
      duration_ms: dm,
      created_at: now,
      updated_at: now
    });
    res.status(201).json({ id, audio_bytes: audio.size });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.put('/api/note-drafts/:id', upload.single('audio'), async (req, res) => {
  try {
    const id = (req.params?.id ?? '').toString().trim();
    const audio = req.file;
    if (!id) return res.status(400).json({ error: 'Missing draft id' });
    if (!audio?.buffer?.length) return res.status(400).json({ error: 'Missing audio file' });
    const existing = await db
      .prepare(`SELECT id, audio_blob_id FROM note_drafts WHERE id = ? AND user_id = ?`)
      .get(id, req.user_id);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });
    const oldBid = (existing?.audio_blob_id ?? '').toString().trim();
    const blobId = sha256Hex(audio.buffer);
    writeBlobIfMissing(blobId, audio.buffer);
    const now = new Date().toISOString();
    const dm = clampInt(req.body?.duration_ms, 0, 24 * 60 * 60 * 1000, 0);
    await db.prepare(
      `UPDATE note_drafts SET audio_blob_id = @audio_blob_id, audio_mime = @audio_mime, audio_bytes = @audio_bytes,
       duration_ms = @duration_ms, updated_at = @updated_at WHERE id = @id AND user_id = @user_id`
    ).run({
      id,
      user_id: req.user_id,
      audio_blob_id: blobId,
      audio_mime: audio.mimetype || 'application/octet-stream',
      audio_bytes: audio.size,
      duration_ms: dm,
      updated_at: now
    });
    if (oldBid && oldBid !== blobId) await maybeUnlinkBlob(db, blobsDir, oldBid);
    res.json({ id, audio_bytes: audio.size });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get('/api/note-drafts/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing draft id' });
  try {
    const row = await db
      .prepare(`SELECT id, audio_bytes, audio_mime, duration_ms, updated_at FROM note_drafts WHERE id = ? AND user_id = ?`)
      .get(id, req.user_id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, ...row });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.delete('/api/note-drafts/:id', async (req, res) => {
  const id = (req.params?.id ?? '').toString().trim();
  if (!id) return res.status(400).json({ error: 'Missing draft id' });
  try {
    const row = await db.prepare(`SELECT audio_blob_id FROM note_drafts WHERE id = ? AND user_id = ?`).get(id, req.user_id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const bid = (row.audio_blob_id ?? '').toString().trim();
    await db.prepare(`DELETE FROM note_drafts WHERE id = ? AND user_id = ?`).run(id, req.user_id);
    await maybeUnlinkBlob(db, blobsDir, bid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/notes', upload.single('audio'), async (req, res) => {
  try {
    const { title, display_title, duration_ms, language, stt_provider, source_filename, draft_id } = req.body ?? {};
    const audio = req.file;
    const draftId = (draft_id ?? '').toString().trim();

    let audioBuffer = null;
    let audioMime = 'application/octet-stream';
    let audioSize = 0;

    if (audio?.buffer?.length) {
      audioBuffer = audio.buffer;
      audioMime = audio.mimetype || audioMime;
      audioSize = audio.size || audioBuffer.length;
    } else if (draftId) {
      const row = await db
        .prepare(`SELECT audio_blob_id, audio_mime, audio_bytes FROM note_drafts WHERE id = ? AND user_id = ?`)
        .get(draftId, req.user_id);
      const bid = (row?.audio_blob_id ?? '').toString().trim();
      const bytes = Number(row?.audio_bytes ?? 0) || 0;
      if (bid && bytes > 0) {
        const blobPath = path.join(blobsDir, bid);
        if (fs.existsSync(blobPath)) {
          audioBuffer = fs.readFileSync(blobPath);
          audioMime = (row?.audio_mime ?? '').toString().trim() || audioMime;
          audioSize = bytes;
        }
      }
    }

    if (!audioBuffer?.length) {
      return res.status(400).json({ error: 'Missing audio file (upload audio or a valid draft_id)' });
    }

    const safeDisplayTitle = (display_title ?? title ?? '').toString().trim();
    const safeDurationMs = clampInt(duration_ms, 0, 24 * 60 * 60 * 1000, 0);
    const safeLanguage = (language ?? '').toString().trim();
    const safeStt = normalizeSttProvider(stt_provider);
    const safeSourceFilename = (source_filename ?? '').toString().trim();
    const stemFromFile = stemFilenameForDisplayTitle(safeSourceFilename);
    const initialDisplayTitle = safeDisplayTitle || stemFromFile || '';
    const ftsTitle = computeFtsTitle(initialDisplayTitle, '');

    const id = nanoid(12);
    const ext = mimeToExt(audioMime) ?? 'webm';
    const audioFilename = `${id}.${ext}`;

    const blobId = sha256Hex(audioBuffer);
    const blobPath = path.join(blobsDir, blobId);
    try {
      if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, audioBuffer);
    } catch {
      // ignore blob store failures; we still have audio_blob in SQLite.
    }

    const createdAt = new Date().toISOString();
    await db.prepare(
      `INSERT INTO notes (id, user_id, title, display_title, body, segments_json, audio_filename, audio_blob_id, audio_mime, audio_bytes, audio_blob, duration_ms, language, stt_provider, created_at, updated_at, status, error)
       VALUES (@id, @user_id, @title, @display_title, @body, @segments_json, @audio_filename, @audio_blob_id, @audio_mime, @audio_bytes, @audio_blob, @duration_ms, @language, @stt_provider, @created_at, @updated_at, @status, @error)`
    ).run({
      id,
      user_id: req.user_id,
      title: ftsTitle,
      display_title: initialDisplayTitle,
      body: '',
      segments_json: '',
      audio_filename: audioFilename,
      audio_blob_id: blobId,
      audio_mime: audioMime || 'application/octet-stream',
      audio_bytes: audioSize,
      audio_blob: audioBuffer,
      duration_ms: safeDurationMs,
      language: safeLanguage,
      stt_provider: safeStt,
      created_at: createdAt,
      updated_at: createdAt,
      status: 'processing',
      error: ''
    });

    if (draftId) {
      try {
        const dr = await db.prepare(`SELECT audio_blob_id FROM note_drafts WHERE id = ? AND user_id = ?`).get(draftId, req.user_id);
        const oldDraftBid = (dr?.audio_blob_id ?? '').toString().trim();
        await db.prepare(`DELETE FROM note_drafts WHERE id = ?`).run(draftId);
        if (oldDraftBid && oldDraftBid !== blobId) await maybeUnlinkBlob(db, blobsDir, oldDraftBid);
      } catch {
        // ignore
      }
    }

    const previewBundleRaw = (req.body?.preview_bundle ?? '').toString();
    const preview = tryParseValidPreviewBundle(previewBundleRaw);
    const finalTranscriptRaw = (req.body?.final_transcript ?? '').toString();
    const clientFinal = !preview ? tryParseClientFinalTranscript(finalTranscriptRaw, safeDurationMs) : null;

    if (preview) {
      const rowAfter = await db
        .prepare(
          `SELECT id, user_id, title, display_title, body, segments_json, language, stt_provider, duration_ms
           FROM notes WHERE id = ? AND user_id = ?`
        )
        .get(id, req.user_id);
      await finalizeNoteFromSttOutput(db, id, rowAfter, {
        transcriptRaw: preview.transcript,
        segments: preview.segments,
        detectedLang: preview.detectedLang,
        transcribe_mode: ''
      });
      res.status(201).json({ id, status: 'ready', transcribe_mode: '', preview_applied: true });
    } else if (clientFinal) {
      const rowAfter = await db
        .prepare(
          `SELECT id, user_id, title, display_title, body, segments_json, language, stt_provider, duration_ms
           FROM notes WHERE id = ? AND user_id = ?`
        )
        .get(id, req.user_id);
      await finalizeNoteFromSttOutput(db, id, rowAfter, {
        transcriptRaw: clientFinal.transcript,
        segments: clientFinal.segments,
        detectedLang: '',
        transcribe_mode: ''
      });
      res.status(201).json({ id, status: 'ready', transcribe_mode: '', preview_applied: true, client_text_applied: true });
    } else {
      await db.prepare(`UPDATE notes SET transcribe_mode = 'retranscribe' WHERE id = ? AND user_id = ?`).run(id, req.user_id);
      res.status(201).json({ id, status: 'processing', transcribe_mode: 'retranscribe', preview_applied: false });
      await enqueueJob(db, { job_type: 'transcribe_note', note_id: id, user_id: req.user_id });
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });
  const safeLanguage = (req.body?.language ?? '').toString().trim();

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__query_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audio.buffer);

  // Long-running STT: disable socket timeout so proxies do not see an idle upstream.
  // (Reverse proxies still need proxy_read_timeout high enough—see deployment notes.)
  try {
    req.socket.setTimeout(0);
  } catch {
    // ignore
  }

    try {
      const out = await transcribeWithLanguageHintFallback(tmpPath, {
        language: safeLanguage
      });
      res.json({
        transcript: formatTranscript(out?.transcript ?? ''),
      language: out?.language ?? '',
      segments: Array.isArray(out?.segments) ? out.segments : []
      });
    } catch (e) {
      if (!res.headersSent) {
        const code = (e?.code ?? '').toString();
        const status = code === 'AUDIO_SILENT' ? 400 : 500;
        res.status(status).json({
          error: 'Transcription failed',
          details: e?.message ?? String(e),
          code
        });
      }
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
});

app.post('/api/detect-language', upload.single('audio'), async (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });

  const hintRaw = (req.body?.language_hint ?? '').toString().trim();
  if (hintRaw) {
    return res.json({ language: hintRaw, source: 'hint' });
  }

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__lang_${id}.${ext}`);
  const probePath = path.join(audioDir, `__langprobe_${id}.wav`);
  fs.writeFileSync(tmpPath, audio.buffer);

  try {
    req.socket.setTimeout(0);
  } catch {
    // ignore
  }

  const probeSec = Math.max(
    12,
    Math.min(180, Number(process.env.VOICEVAULT_DETECT_LANGUAGE_MAX_SEC ?? '55') || 55)
  );
  let audioForDetect = tmpPath;
  let haveProbe = false;
  try {
    haveProbe = await writeLangProbeWavClip(tmpPath, probePath, probeSec);
    if (haveProbe) audioForDetect = probePath;
  } catch {
    audioForDetect = tmpPath;
  }

  try {
    const out = await transcribeAudioFile(audioForDetect, {
      language: ''
    });
    res.json({ language: out?.language ?? '', source: haveProbe ? 'probe' : 'full' });
  } catch (e) {
    if (!res.headersSent) {
      const code = (e?.code ?? '').toString();
      const status = code === 'AUDIO_SILENT' ? 400 : 500;
      res.status(status).json({
        error: 'Language detection failed',
        details: e?.message ?? String(e),
        code
      });
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    try {
      if (haveProbe) fs.unlinkSync(probePath);
    } catch {
      // ignore
    }
  }
});

app.post('/api/live-transcribe', upload.single('audio'), async (req, res) => {
  const audio = req.file;
  if (!audio) return res.status(400).json({ error: 'Missing audio file' });
  const safeLanguage = (req.body?.language ?? '').toString().trim();

  const id = nanoid(12);
  const ext = mimeToExt(audio.mimetype) ?? 'webm';
  const tmpPath = path.join(audioDir, `__live_${id}.${ext}`);
  fs.writeFileSync(tmpPath, audio.buffer);

  try {
    req.socket.setTimeout(0);
  } catch {
    // ignore
  }

  try {
    const out = await transcribeWithLanguageHintFallback(tmpPath, {
      language: safeLanguage
    });
    res.json({
      transcript: formatTranscript(out?.transcript ?? ''),
      language: out?.language ?? ''
    });
  } catch (e) {
    if (!res.headersSent) {
      const code = (e?.code ?? '').toString();
      const status = code === 'AUDIO_SILENT' ? 400 : 500;
      res.status(status).json({
        error: 'Live transcription failed',
        details: e?.message ?? String(e),
        code
      });
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
});

app.get('/api/notes', async (req, res) => {
  const userId = currentUserId(req);
  const q = (req.query.q ?? '').toString().trim();
  const limit = clampInt(req.query.limit, 1, 100, 50);
  const offset = clampInt(req.query.offset, 0, 100000, 0);
  const folderId = (req.query.folder_id ?? '').toString().trim();
  const statusFilter = (req.query.status ?? '').toString().trim();
  const tagName = (req.query.tag ?? '').toString().trim();
  const favoriteOnly = (req.query.favorite ?? '').toString().trim() === '1';

  const adv = await parseAdvancedSearchOps(db, q);
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
    const tLike = `%${adv.title.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    extraWhere.push(`(n.display_title LIKE ? ESCAPE '\\' OR n.title LIKE ? ESCAPE '\\')`);
    extraArgs.push(tLike, tLike);
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
    rows = await db
      .prepare(
        `SELECT n.id, n.title, n.display_title, n.body, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.stt_provider, n.audio_filename, n.folder_id, n.is_favorite,
                n.transcribe_mode,
                COALESCE(nps.paused, 0) AS processing_paused
         FROM notes n
         LEFT JOIN note_processing_state nps ON nps.note_id = n.id
         WHERE n.user_id = ?${extraSql}
         ORDER BY n.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, ...extraArgs, limit, offset);
  } else if ((!qText || !ftsQ) && hasTimeFilter) {
    rows = await db
      .prepare(
        `SELECT n.id, n.title, n.display_title, n.body, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.stt_provider, n.audio_filename, n.folder_id, n.is_favorite,
                n.transcribe_mode,
                COALESCE(nps.paused, 0) AS processing_paused
         FROM notes n
         LEFT JOIN note_processing_state nps ON nps.note_id = n.id
         WHERE n.user_id = ? AND n.created_at >= ? AND n.created_at <= ?${extraSql}
         ORDER BY n.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(userId, fromIso, toIso, ...extraArgs, limit, offset);
  } else {
    // Postgres FTS path: notes.tsv (generated tsvector on title+body) + GIN index.
    // We translate the SQLite FTS5-style `foo* bar*` into Postgres tsquery `foo:* & bar:*`
    // (see convertSqliteFtsToPostgresTsquery in db.js). Ranking uses ts_rank_cd, ASC by
    // negated rank to keep "highest match first" parity with SQLite's bm25 which is a
    // distance-like score (lower = better).
    const pgTsQuery = convertSqliteFtsToPostgresTsquery(ftsQ);
    try {
      if (!pgTsQuery) throw new Error('empty_tsquery');
      rows = await db
        .prepare(
          `SELECT n.id, n.title, n.display_title, n.body, n.segments_json, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.stt_provider, n.audio_filename, n.folder_id, n.is_favorite,
                 n.transcribe_mode,
                 COALESCE(nps.paused, 0) AS processing_paused,
                 ts_rank_cd(n.tsv, to_tsquery('english', ?)) AS rank
           FROM notes n
           LEFT JOIN note_processing_state nps ON nps.note_id = n.id
           WHERE n.tsv @@ to_tsquery('english', ?)
           AND n.user_id = ?
           ${hasTimeFilter ? 'AND n.created_at >= ? AND n.created_at <= ?' : ''}
           ${extraSql}
           ORDER BY rank DESC
           LIMIT ? OFFSET ?`
        )
        .all(
          pgTsQuery,
          ...(hasTimeFilter ? [pgTsQuery, userId, fromIso, toIso] : [pgTsQuery, userId]),
          ...extraArgs,
          limit,
          offset
        );
    } catch {
      // tsquery parse errors or any other FTS failure falls back to ILIKE substring.
      // Postgres ILIKE handles the case-insensitive match natively.
      const like = `%${effectiveQuery.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      rows = await db
        .prepare(
          `SELECT n.id, n.title, n.display_title, n.body, n.segments_json, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.audio_bytes, n.language, n.stt_provider, n.audio_filename, n.folder_id, n.is_favorite,
                  n.transcribe_mode,
                  COALESCE(nps.paused, 0) AS processing_paused
           FROM notes n
           LEFT JOIN note_processing_state nps ON nps.note_id = n.id
           WHERE n.user_id = ?
           AND (n.display_title ILIKE ? OR n.title ILIKE ? OR n.body ILIKE ?)
           ${hasTimeFilter ? 'AND n.created_at >= ? AND n.created_at <= ?' : ''}
           ${extraSql}
           ORDER BY n.created_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(
          ...(hasTimeFilter ? [userId, like, like, like, fromIso, toIso] : [userId, like, like, like]),
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
    items: await attachProcessingEtaFields(db, rows)
  });
});

app.get('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const row = await db
    .prepare(
      `SELECT id, title, display_title, body, segments_json, audio_filename, audio_blob_id, audio_mime, audio_bytes, duration_ms, language, stt_provider, created_at, updated_at, status, error, folder_id, is_favorite, transcribe_mode
       FROM notes
       WHERE id = ? AND user_id = ?`
    )
    .get(id, currentUserId(req));

  if (!row) return res.status(404).json({ error: 'Not found' });

  const segRows = await db
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
  const adv = await parseAdvancedSearchOps(db, q);
  const { text: qText, fromIso, toIso } = extractTimeRangeAndText(adv.text);
  const effectiveQuery = qText ? rewriteSearchQuery(qText) : '';
  try {
    const out = await semanticSearch(db, {
      query: effectiveQuery,
      fromIso,
      toIso,
      topK,
      filters: {
        user_id: currentUserId(req),
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

app.patch('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const bodyIn = req.body ?? {};
  const legacyTitle = (bodyIn.title ?? '').toString().trim();
  const hasDisplayKey = Object.prototype.hasOwnProperty.call(bodyIn, 'display_title');
  const hasBodyKey = Object.prototype.hasOwnProperty.call(bodyIn, 'body');
  const hasLanguageKey = Object.prototype.hasOwnProperty.call(bodyIn, 'language');
  const hasSttKey = Object.prototype.hasOwnProperty.call(bodyIn, 'stt_provider');
  const folderId = (req.body?.folder_id ?? '').toString().trim();
  const favoriteRaw = req.body?.is_favorite;
  const hasFavorite = typeof favoriteRaw !== 'undefined';
  const isFavorite = hasFavorite ? ((favoriteRaw ?? 0).toString().trim() === '1' || favoriteRaw === true ? 1 : 0) : null;

  const prev = await db
    .prepare(`SELECT id, title, display_title, body, language, stt_provider FROM notes WHERE id = ? AND user_id = ?`)
    .get(id, req.user_id);
  if (!prev) return res.status(404).json({ error: 'Not found' });

  if (folderId) {
    const okFolder = await db.prepare(`SELECT id FROM folders WHERE id = ? AND user_id = ?`).get(folderId, req.user_id);
    if (!okFolder) return res.status(400).json({ error: 'Invalid folder' });
  }

  const displayTitle = hasDisplayKey
    ? (bodyIn.display_title ?? '').toString().trim()
    : legacyTitle || (prev.display_title ?? '').toString().trim();
  const body = hasBodyKey ? (bodyIn.body ?? '').toString() : (prev.body ?? '').toString();
  const language = hasLanguageKey ? (bodyIn.language ?? '').toString().trim() : (prev.language ?? '').toString().trim();

  const ftsTitle = computeFtsTitle(displayTitle, body);

  const updatedAt = new Date().toISOString();
  const parts = [
    `title = @title`,
    `display_title = @display_title`,
    `body = @body`,
    `language = @language`,
    `status = @status`,
    `error = @error`,
    `updated_at = @updated_at`
  ];
  if (folderId) parts.push(`folder_id = @folder_id`);
  if (hasFavorite) parts.push(`is_favorite = @is_favorite`);
  if (hasSttKey) parts.push(`stt_provider = @stt_provider`);
  const sql = `UPDATE notes SET ${parts.join(', ')} WHERE id = @id AND user_id = @user_id`;
  const runParams = {
    id,
    user_id: req.user_id,
    title: ftsTitle,
    display_title: displayTitle,
    body,
    language,
    folder_id: folderId || '',
    is_favorite: isFavorite ?? 0,
    status: 'ready',
    error: '',
    updated_at: updatedAt
  };
  if (hasSttKey) runParams.stt_provider = normalizeSttProvider(bodyIn.stt_provider);
  const run = await db.prepare(sql).run(runParams);
  if (!run.changes) return res.status(404).json({ error: 'Not found' });

  res.json({ ok: true, id });
});

/** Permanently removes note + dependent rows + on-disk audio file. Returns true if a row was deleted. */
async function deleteNoteCascade(noteId, userId) {
  const nid = (noteId ?? '').toString().trim();
  const uid = (userId ?? '').toString().trim();
  if (!nid || !uid) return false;
  const row = await db.prepare(`SELECT audio_filename FROM notes WHERE id = ? AND user_id = ?`).get(nid, uid);
  if (!row) return false;

  await db.tx(async (txDb) => {
    await txDb.prepare(`DELETE FROM job_events WHERE job_id IN (SELECT id FROM ingestion_jobs WHERE note_id = ?)`).run(nid);
    await txDb.prepare(`DELETE FROM job_events WHERE note_id = ?`).run(nid);
    await txDb.prepare(`DELETE FROM ingestion_jobs WHERE note_id = ?`).run(nid);
    await txDb.prepare(`DELETE FROM note_processing_state WHERE note_id = ?`).run(nid);
    await txDb.prepare(`DELETE FROM note_segments WHERE note_id = ?`).run(nid);
    await txDb.prepare(`DELETE FROM note_chunks WHERE note_id = ?`).run(nid);
    await txDb.prepare(`DELETE FROM note_tags WHERE note_id = ?`).run(nid);
    await txDb.prepare(`DELETE FROM notes WHERE id = ? AND user_id = ?`).run(nid, uid);
  });

  const audioPath = path.join(audioDir, row.audio_filename);
  try {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  } catch {
    // ignore
  }
  return true;
}

app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const nid = (id ?? '').toString().trim();
  if (!nid) return res.status(400).json({ error: 'Missing id' });

  if (!await deleteNoteCascade(nid, req.user_id)) return res.status(404).json({ error: 'Not found' });

  res.json({ ok: true, id: nid });
});

app.get('/api/notes/:id/audio', async (req, res) => {
  const { id } = req.params;
  const row = await db
    .prepare(`SELECT audio_filename, audio_blob_id, audio_mime, audio_blob FROM notes WHERE id = ? AND user_id = ?`)
    .get(id, req.user_id);
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
          await db.prepare(`UPDATE notes SET audio_blob_id = @audio_blob_id WHERE id = @id AND user_id = @user_id`).run({
            id,
            user_id: req.user_id,
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

app.get('/api/blobs/:id', async (req, res) => {
  const blobId = (req.params?.id ?? '').toString().trim();
  if (!blobId || !/^[a-f0-9]{64}$/i.test(blobId)) return res.status(400).end();
  const p = path.join(blobsDir, blobId);
  if (!fs.existsSync(p)) return res.status(404).end();

  const allowed = await db
    .prepare(`SELECT 1 AS ok FROM notes WHERE audio_blob_id = ? AND user_id = ? LIMIT 1`)
    .get(blobId, req.user_id);
  if (!allowed) return res.status(404).end();

  // Content-Type: best-effort from notes table (fallback octet-stream).
  // If multiple notes reference a blob, pick any matching mime.
  const mimeRow = await db
    .prepare(`SELECT audio_mime FROM notes WHERE audio_blob_id = ? AND user_id = ? AND audio_mime != '' LIMIT 1`)
    .get(blobId, req.user_id);
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

app.post('/api/notes/:id/retry', async (req, res) => {
  const { id } = req.params;
  const row = await db
    .prepare(
      `SELECT id, audio_filename, audio_mime, audio_blob, audio_blob_id, language, stt_provider
       FROM notes WHERE id = ? AND user_id = ?`
    )
    .get(id, req.user_id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Ensure we have a durable audio_blob_id for ingestion jobs (they read from blobsDir).
  let blobId = (row.audio_blob_id ?? '').toString().trim();
  if (!blobId) {
    let audioBuf = null;
    if (row.audio_blob && Buffer.isBuffer(row.audio_blob) && row.audio_blob.length > 0) {
      audioBuf = row.audio_blob;
    } else {
      const audioPath = path.join(audioDir, row.audio_filename);
      if (!fs.existsSync(audioPath)) return res.status(404).json({ error: 'Audio missing' });
      audioBuf = fs.readFileSync(audioPath);
    }
    if (!audioBuf || audioBuf.length === 0) return res.status(400).json({ error: 'Audio missing' });
    blobId = sha256Hex(audioBuf);
    try {
      const blobPath = path.join(blobsDir, blobId);
      if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, audioBuf);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to persist audio blob', details: e?.message ?? String(e) });
    }
    try {
      await db.prepare(`UPDATE notes SET audio_blob_id = @audio_blob_id WHERE id = @id AND user_id = @user_id`).run({
        id,
        user_id: req.user_id,
        audio_blob_id: blobId
      });
    } catch {
      // ignore
    }
  }

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE notes
     SET status = @status,
         transcribe_mode = @transcribe_mode,
         error = @error,
         updated_at = @updated_at
     WHERE id = @id AND user_id = @user_id`
  ).run({
    id,
    user_id: req.user_id,
    status: 'processing',
    transcribe_mode: 'retranscribe',
    error: '',
    updated_at: now
  });

  // Resume any paused pipeline for this note and clear stop flags so queued workers can run; timer uses fresh updated_at.
  try {
    await db.prepare(
      `INSERT INTO note_processing_state (note_id, user_id, paused, cancel_requested, updated_at)
       VALUES (@note_id, @user_id, 0, 0, @updated_at)
       ON CONFLICT(note_id) DO UPDATE SET user_id = excluded.user_id, paused = 0, cancel_requested = 0, updated_at = excluded.updated_at`
    ).run({ note_id: id, user_id: req.user_id, updated_at: now });
  } catch {
    // ignore if columns mismatch old DB
  }

  // Durable jobs so they show up in Processes panel and can be retried/cancelled.
  await enqueueJob(db, { job_type: 'transcribe_note', note_id: id, user_id: req.user_id, priority: 1 });
  await enqueueJob(db, { job_type: 'backfill_words', note_id: id, user_id: req.user_id, priority: 0 });

  res.json({ ok: true, id, status: 'processing' });
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

/** Clear screen + scrollback on startup so each restart does not show old terminal output (CI: VOICEVAULT_CLEAR_CONSOLE=0). */
function clearStartupConsole() {
  if ((process.env.VOICEVAULT_CLEAR_CONSOLE ?? '1').toString().trim() === '0') return;
  if (!process.stdout.isTTY) return;
  try {
    // \x1B[3J = erase scrollback (xterm / VS Code); \x1B[2J\x1B[H = clear viewport + home cursor
    process.stdout.write('\x1B[3J\x1B[2J\x1B[H');
  } catch {
    // ignore
  }
}

app.listen(PORT, () => {
  clearStartupConsole();
  // eslint-disable-next-line no-console
  console.log(`voiceVault running on http://localhost:${PORT}`);
  void warmupWhisperPipeline().catch(() => {});
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
    const headline = (r?.display_title ?? '').toString().trim() || (r?.title ?? '').toString();
    const body = (r?.body ?? '').toString();
    const docText = `${headline}\n${body}`;

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

/** Same caps as client `vvSanitizePreviewSegments` / `sanitizeSegmentsForPersistence`. */
function sanitizePreviewSegmentsForSave(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = (s?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    out.push({ start, end, text });
    if (out.length >= 8000) break;
  }
  return out;
}

/**
 * @returns {null | { transcript: string, segments: Array<{start:number,end:number,text:string}>, detectedLang: string, languageHint: string }}
 */
function tryParseValidPreviewBundle(previewBundleRaw) {
  const raw = (previewBundleRaw ?? '').toString().trim();
  if (!raw) return null;
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const segments = sanitizePreviewSegmentsForSave(j?.segments);
  const transcriptRaw = (j?.transcript ?? '').toString();
  const transcript = formatTranscript(transcriptRaw).trim();
  if (!transcript || segments.length === 0) return null;
  return {
    transcript,
    segments,
    detectedLang: (j?.detected_language ?? '').toString().trim(),
    languageHint: (j?.language_hint ?? '').toString().trim()
  };
}

const FINAL_TRANSCRIPT_MAX_CHARS = 400_000;

/**
 * When the user edited the full preview, the client may send `final_transcript` instead of a preview bundle.
 * We persist one synthetic segment spanning the note duration so chunks/FTS still have a timeline anchor.
 */
function tryParseClientFinalTranscript(finalTranscriptRaw, durationMs) {
  const t = formatTranscript((finalTranscriptRaw ?? '').toString()).trim();
  if (!t || t.length > FINAL_TRANSCRIPT_MAX_CHARS) return null;
  const dm = Number(durationMs) || 0;
  const endSec = Math.max(0.001, dm > 0 ? dm / 1000 : 60);
  const oneLine = t.replace(/\s+/g, ' ').trim();
  const segments = [{ start: 0, end: endSec, text: oneLine }];
  return { transcript: t, segments };
}

/**
 * If the UI sent a language hint and STT returns no usable text (wrong locale for multilingual speech is common),
 * retry once with auto-detect (empty language string). Matches client-side live/full preview fallback.
 */
async function transcribeWithLanguageHintFallback(tmpPath, { language }) {
  const hint = (language ?? '').toString().trim();
  const first = await transcribeAudioFile(tmpPath, {
    language: hint
  });
  const text = formatTranscript(first?.transcript ?? '').trim();
  const segs = Array.isArray(first?.segments) ? first.segments : [];
  const hasSegText = segs.some((s) => ((s?.text ?? '').toString().trim().length > 0));
  if (text || hasSegText || !hint) return first;
  return transcribeAudioFile(tmpPath, {
    language: ''
  });
}

/** Full-file authoritative STT via ElevenLabs (word timestamps + segments). */
async function transcribeAuthoritativeFullFile(tmpPath, { language }) {
  return transcribeWithLanguageHintFallback(tmpPath, { language });
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

/** Shared persistence for STT output (queue job or inline /retry). */
async function finalizeNoteFromSttOutput(
  db,
  noteId,
  row,
  { transcriptRaw, segments, detectedLang, transcribe_mode = '' } = {}
) {
  const transcript = formatTranscript(transcriptRaw ?? '');
  let segArr = Array.isArray(segments) ? segments : [];
  if (!segArr.length && transcript.trim()) {
    segArr = segmentsFromTranscriptFallback(transcript, Number(row?.duration_ms ?? 0) || 0);
  }
  const segmentsJson = safeStringifySegments(segArr);
  await ensureNoteSegments(db, noteId, segArr);
  await ensureNoteChunks(db, noteId, segArr);

  const updatedAt = new Date().toISOString();
  const priorDisplay = (row.display_title ?? '').toString().trim();
  const finalDisplayTitle =
    priorDisplay || (transcript ? transcript.slice(0, 64).trim() : '') || '';
  const ftsTitle = computeFtsTitle(finalDisplayTitle, transcript);

  const hintLang = (row.language ?? '').toString().trim();
  const detectedNorm = normalizeDetectedLanguage(detectedLang);
  const storedLang = persistedNoteLanguage(hintLang, detectedNorm);

  const mode = (transcribe_mode ?? '').toString().trim();

  const uid = (row?.user_id ?? '').toString().trim();
  if (!uid) return false;
  const r = await db
    .prepare(
      `UPDATE notes
       SET title = @title,
           display_title = @display_title,
           body = @body,
           segments_json = @segments_json,
           language = @language,
           status = 'ready',
           error = '',
           transcribe_mode = @transcribe_mode,
           updated_at = @updated_at
       WHERE id = @id AND status = 'processing' AND user_id = @user_id`
    )
    .run({
      id: noteId,
      user_id: uid,
      title: ftsTitle,
      display_title: finalDisplayTitle,
      body: transcript || '',
      segments_json: segmentsJson,
      language: storedLang,
      transcribe_mode: mode,
      updated_at: updatedAt
    });
  return (r?.changes ?? 0) > 0;
}

function segmentsFromTranscriptFallback(transcript, durationMs) {
  const t = (transcript ?? '').toString().trim();
  if (!t) return [];
  const durSec = Math.max(1.0, (Number(durationMs) || 0) > 0 ? (Number(durationMs) || 0) / 1000 : 60);

  const parts = t
    .replaceAll('\r\n', '\n')
    .split(/\n+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => s.split(/(?<=[.!?])\s+/g).map((x) => x.trim()).filter(Boolean));

  const clipped = parts.slice(0, 120);
  if (!clipped.length) return [];

  const weights = clipped.map((s) => Math.max(1, s.replace(/\s+/g, ' ').length));
  const total = weights.reduce((a, b) => a + b, 0);
  const MIN_SEC = 0.4;
  const maxN = Math.min(clipped.length, Math.max(1, Math.floor(durSec / MIN_SEC)));
  const lines = clipped.slice(0, maxN);
  const w2 = weights.slice(0, maxN);
  const tot2 = w2.reduce((a, b) => a + b, 0) || 1;

  const out = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const frac = w2[i] / tot2;
    const span = Math.max(MIN_SEC, durSec * frac);
    const start = cursor;
    const end = i === lines.length - 1 ? durSec : Math.min(durSec, cursor + span);
    cursor = end;
    const text = lines[i].replace(/\s+/g, ' ').trim();
    if (text) out.push({ start, end, text });
    if (cursor >= durSec - 0.001) break;
  }
  if (!out.length) {
    const oneLine = t.replace(/\s+/g, ' ').trim();
    return oneLine ? [{ start: 0, end: durSec, text: oneLine }] : [];
  }
  // Ensure strictly increasing end times.
  for (let i = 0; i < out.length; i += 1) {
    const prev = out[i - 1];
    if (prev && out[i].start < prev.end) out[i].start = prev.end;
    if (out[i].end <= out[i].start) out[i].end = Math.min(durSec, out[i].start + MIN_SEC);
  }
  return out.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);
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
        word: ((w?.word ?? w?.text ?? '') ?? '').toString()
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

async function enqueueJob(db, { job_type, note_id, user_id = '', max_attempts = 3, priority = 0 } = {}) {
  try {
    const id = nanoid(12);
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO ingestion_jobs (id, job_type, note_id, user_id, status, attempts, max_attempts, locked_at, available_at, priority, last_error, created_at, updated_at)
       VALUES (@id, @job_type, @note_id, @user_id, @status, @attempts, @max_attempts, @locked_at, @available_at, @priority, @last_error, @created_at, @updated_at)`
    ).run({
      id,
      job_type: (job_type ?? '').toString(),
      note_id: (note_id ?? '').toString(),
      user_id: (user_id ?? '').toString(),
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
      await appendJobEvent(db, {
        jobId: id,
        noteId: (note_id ?? '').toString(),
        userId: (user_id ?? '').toString(),
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

async function appendJobEvent(db, { jobId, noteId = '', userId = '', eventType, message = '', meta = null } = {}) {
  const id = nanoid(12);
  const now = new Date().toISOString();
  const job_id = (jobId ?? '').toString().trim();
  const note_id = (noteId ?? '').toString().trim();
  let user_id = (userId ?? '').toString().trim();
  if (!user_id && note_id) {
    try {
      const r = await db.prepare(`SELECT user_id FROM notes WHERE id = ?`).get(note_id);
      user_id = (r?.user_id ?? '').toString().trim();
    } catch {
      user_id = '';
    }
  }
  if (!user_id && job_id) {
    try {
      const r = await db.prepare(`SELECT user_id FROM ingestion_jobs WHERE id = ?`).get(job_id);
      user_id = (r?.user_id ?? '').toString().trim();
    } catch {
      user_id = '';
    }
  }
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
    await db.prepare(
      `INSERT INTO job_events (id, job_id, note_id, user_id, event_type, message, meta_json, created_at)
       VALUES (@id, @job_id, @note_id, @user_id, @event_type, @message, @meta_json, @created_at)`
    ).run({
      id,
      job_id,
      note_id,
      user_id,
      event_type,
      message: msg,
      meta_json,
      created_at: now
    });
  } catch {
    // ignore
  }
}

async function getAppState(db, key) {
  const k = (key ?? '').toString().trim();
  if (!k) return '';
  try {
    const row = await db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(k);
    return (row?.value ?? '').toString();
  } catch {
    return '';
  }
}

async function setAppState(db, key, value) {
  const k = (key ?? '').toString().trim();
  if (!k) return;
  const v = (value ?? '').toString();
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (@key, @value, @updated_at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run({ key: k, value: v, updated_at: now });
  } catch {
    // ignore
  }
}

async function isIngestionPaused(db) {
  const v = await getAppState(db, 'ingestion_paused');
  return v === '1' || v.toLowerCase() === 'true';
}

async function getIngestionMaxParallel(db) {
  const v = await getAppState(db, 'ingestion_max_parallel');
  const n = Number.parseInt((v ?? '').toString(), 10);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.min(6, n));
}

function startIngestionWorkerImpl(getDb, { blobsDir }) { /* sync entry; inner timer callback is async */
  // Pick up new `queued` jobs quickly so the UI does not sit on `processing_coarse_stage=queued` for ~1s+ on every save.
  const tickMs = Math.max(200, Math.min(5000, Number(process.env.VOICEVAULT_INGESTION_TICK_MS ?? '450') || 450));
  let active = 0;
  const timer = setInterval(async () => {
    const db = getDb?.();
    if (!db) return;
    try {
      if (await isIngestionPaused(db)) return;
      // Keep queue healthy: unlock stale running jobs.
      await unlockStaleJobs(db);
      const maxP = await getIngestionMaxParallel(db);
      if (active >= maxP) return;
      active += 1;
      processNextJob(db, { blobsDir })
        .catch(() => {
          // ignore
        })
        .finally(() => {
          active = Math.max(0, active - 1);
        });
    } catch {
      // ignore worker tick errors
    }
  }, tickMs);
  return timer;
}

async function processNextJob(db, { blobsDir }) {
  const now = new Date().toISOString();
  if (await isIngestionPaused(db)) return;

  // Acquire one queued job.
  const job = await db
    .prepare(
      `SELECT j.id, j.job_type, j.note_id, j.attempts, j.max_attempts, j.available_at, j.priority, n.user_id AS note_user_id
       FROM ingestion_jobs j
       JOIN notes n ON n.id = j.note_id
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
  await db.prepare(
    `UPDATE ingestion_jobs
     SET status = 'running', locked_at = @locked_at, available_at = '', attempts = attempts + 1, updated_at = @updated_at
     WHERE id = @id`
  ).run({ id: job.id, locked_at: now, updated_at: now });
  await appendJobEvent(db, {
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

    await db.prepare(
      `UPDATE ingestion_jobs SET status = 'done', updated_at = @updated_at WHERE id = @id`
    ).run({ id: job.id, updated_at: new Date().toISOString() });
    await appendJobEvent(db, {
      jobId: job.id,
      noteId: job.note_id,
      eventType: 'done',
      message: 'Job completed'
    });
  } catch (e) {
    if (e?.code === 'VV_CANCEL' || e?.message === '__VV_CANCEL__') {
      const u = new Date().toISOString();
      await db.prepare(
        `UPDATE ingestion_jobs
         SET status = 'cancelled', last_error = 'Stopped by user', locked_at = '', updated_at = @updated_at
         WHERE id = @id`
      ).run({ id: job.id, updated_at: u });
      await appendJobEvent(db, {
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
    const nextAvailableAt = terminal ? '' : await computeNextAvailableAtIso(db, { attempts });

    await db.prepare(
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
    await appendJobEvent(db, {
      jobId: job.id,
      noteId: job.note_id,
      eventType: terminal ? 'error' : 'retry',
      message: terminal ? 'Job failed (terminal)' : 'Job failed (will retry)',
      meta: { attempts, max_attempts: maxAttempts, next_available_at: nextAvailableAt || '' }
    });

    // Only mark the note itself as error for primary transcription jobs.
    if (terminal && job.job_type === 'transcribe_note') {
      await db.prepare(
        `UPDATE notes SET status = 'error', error = @error, updated_at = @updated_at WHERE id = @id AND user_id = @user_id`
      ).run({
        id: job.note_id,
        user_id: (job.note_user_id ?? '').toString(),
        error: msg,
        updated_at: new Date().toISOString()
      });
    }
  }
}

async function unlockStaleJobs(db, { force = false, userId = '' } = {}) {
  const timeoutSec = clampInt(process.env.INGESTION_LOCK_TIMEOUT_SEC, 60, 24 * 60 * 60, 20 * 60);
  const cutoff = new Date(Date.now() - timeoutSec * 1000).toISOString();
  const now = new Date().toISOString();
  const uid = (userId ?? '').toString().trim();
  try {
    let stale = [];
    try {
      stale = uid
        ? await db
            .prepare(
              `SELECT j.id, j.note_id, j.job_type, j.locked_at
               FROM ingestion_jobs j
               JOIN notes n ON n.id = j.note_id
               WHERE j.status = 'running'
                 AND j.locked_at != ''
                 AND j.locked_at < @cutoff
                 AND n.user_id = @user_id
               LIMIT 200`
            )
            .all({ cutoff, user_id: uid })
        : await db
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
    const r = uid
      ? await db
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
               AND locked_at < @cutoff
               AND note_id IN (SELECT id FROM notes WHERE user_id = @user_id)`
          )
          .run({
            now,
            cutoff,
            user_id: uid,
            msg: `Unlocked stale running job (lock>${timeoutSec}s)`
          })
      : await db
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
        await appendJobEvent(db, {
          jobId: s?.id,
          noteId: s?.note_id,
          eventType: 'unlock_stale',
          message: `Unlocked stale job (lock>${timeoutSec}s)`,
          meta: { locked_at: (s?.locked_at ?? '').toString(), job_type: (s?.job_type ?? '').toString() }
        });
      }
    }
    if (changes > 0 || force) {
      await setAppState(db, 'jobs_last_stale_unlock_at', now);
      await setAppState(db, 'jobs_last_stale_unlock_count', String(changes));
    }
    return changes;
  } catch {
    // ignore
    return 0;
  }
}

async function computeNextAvailableAtIso(db, { attempts }) {
  // attempts is 1-based at this point (we increment before running).
  // Backoff: base*2^(attempt-1) up to max (+ small jitter).
  const a = Math.max(1, Number(attempts) || 1);
  const baseMs = await getBackoffBaseSec(db) * 1000;
  const maxMs = await getBackoffMaxSec(db) * 1000;
  const exp = baseMs * Math.pow(2, Math.max(0, a - 1));
  const jitter = Math.floor(Math.random() * 750); // keep small, avoids herd effect
  const delayMs = Math.min(maxMs, exp) + jitter;
  return new Date(Date.now() + delayMs).toISOString();
}

async function getBackoffBaseSec(db) {
  const v = await getAppState(db, 'ingestion_backoff_base_sec');
  const n = Number.parseInt((v ?? '').toString(), 10);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(1, Math.min(60, n));
}

async function getBackoffMaxSec(db) {
  const v = await getAppState(db, 'ingestion_backoff_max_sec');
  const n = Number.parseInt((v ?? '').toString(), 10);
  if (!Number.isFinite(n) || n <= 0) return 300;
  return Math.max(5, Math.min(3600, n));
}

async function runTranscribeJob(db, { noteId, blobsDir }) {
  const row = await db
    .prepare(
      `SELECT id, user_id, title, display_title, audio_blob_id, audio_mime, audio_bytes, duration_ms, language, stt_provider
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
    await throwIfTranscribeCancelled(db, noteId);

    let cancelledDuringTranscribe = false;
    const pollIv = setInterval(async () => {
      try {
        await throwIfTranscribeCancelled(db, noteId);
      } catch (e) {
        if (e?.code === 'VV_CANCEL') cancelledDuringTranscribe = true;
      }
    }, 900);

    try {
      const hintForStt = (row.language ?? '').toString().trim();
      const out = await transcribeAuthoritativeFullFile(tmpPath, {
        language: hintForStt
      });

      if (cancelledDuringTranscribe) {
        const e = new Error('__VV_CANCEL__');
        e.code = 'VV_CANCEL';
        throw e;
      }
      await throwIfTranscribeCancelled(db, noteId);

      await finalizeNoteFromSttOutput(db, noteId, row, {
        transcriptRaw: out?.transcript ?? '',
        segments: Array.isArray(out?.segments) ? out.segments : [],
        detectedLang: out?.language ?? '',
        transcribe_mode: ''
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
  const row = await db
    .prepare(
      `SELECT id, user_id, audio_blob_id, audio_mime, language, stt_provider
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
      language: (row.language ?? '').toString().trim()
    });

    // Important: do NOT overwrite notes.body/segments_json for older notes.
    // Only refresh the derived tables that store words.
    await ensureNoteSegments(db, noteId, Array.isArray(out?.segments) ? out.segments : []);
    await ensureNoteChunks(db, noteId, Array.isArray(out?.segments) ? out.segments : []);

    const hintLang = (row.language ?? '').toString().trim();
    const detectedLang = normalizeDetectedLanguage(out?.language);
    const storedLang = persistedNoteLanguage(hintLang, detectedLang);
    if (!hintLang && storedLang) {
      await db.prepare(`UPDATE notes SET language = @language, updated_at = @updated_at WHERE id = @id AND user_id = @user_id`).run({
        id: noteId,
        user_id: (row.user_id ?? '').toString(),
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

async function parseAdvancedSearchOps(db, rawQ) {
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
        const row = await db.prepare(`SELECT id FROM folders WHERE name = ?`).get(folderVal);
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

