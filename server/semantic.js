import { DEFAULT_EMBED_MODEL, bufferToFloat32, cosineSim, embedTexts, float32ToBuffer } from './embeddings.js';
import { crossEncoderRerank } from './rerank.js';

export async function ensureNoteSegments(db, noteId, segments, { embedModel = DEFAULT_EMBED_MODEL } = {}) {
  if (!noteId || !Array.isArray(segments)) return;
  const now = new Date().toISOString();
  const del = db.prepare(`DELETE FROM note_segments WHERE note_id = ?`);
  const ins = db.prepare(
    `INSERT INTO note_segments (note_id, seg_idx, start_sec, end_sec, text, words_json, embedding, embed_model, created_at, updated_at)
     VALUES (@note_id, @seg_idx, @start_sec, @end_sec, @text, @words_json, @embedding, @embed_model, @created_at, @updated_at)`
  );

  const tx = db.transaction(() => {
    del.run(noteId);
    for (let i = 0; i < segments.length; i += 1) {
      const s = segments[i];
      const start = Number(s?.start);
      const end = Number(s?.end);
      const text = (s?.text ?? '').toString().trim();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
      const wordsJson = safeStringifyWords(s?.words);
      ins.run({
        note_id: noteId,
        seg_idx: i,
        start_sec: start,
        end_sec: end,
        text,
        words_json: wordsJson,
        embedding: null,
        embed_model: embedModel,
        created_at: now,
        updated_at: now
      });
    }
  });
  tx();
}

export function buildChunksFromSegments(segments, { maxChars = 900, maxSegs = 6 } = {}) {
  const segs = Array.isArray(segments) ? segments : [];
  const out = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.textParts.join(' ').replaceAll(/\s+/g, ' ').trim();
    if (text) {
      out.push({
        start: cur.start,
        end: cur.end,
        text,
        segStartIdx: cur.segStartIdx,
        segEndIdx: cur.segEndIdx
      });
    }
    cur = null;
  };

  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = (s?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;

    if (!cur) {
      cur = { start, end, textParts: [text], segStartIdx: i, segEndIdx: i };
      continue;
    }

    const nextText = `${cur.textParts.join(' ')} ${text}`.trim();
    const segCount = cur.segEndIdx - cur.segStartIdx + 1;
    const tooBig = nextText.length > maxChars || segCount >= maxSegs || start - cur.end > 1.2;
    if (tooBig) {
      flush();
      cur = { start, end, textParts: [text], segStartIdx: i, segEndIdx: i };
      continue;
    }

    cur.textParts.push(text);
    cur.end = end;
    cur.segEndIdx = i;
  }
  flush();
  return out;
}

export async function ensureNoteChunks(db, noteId, segments, { embedModel = DEFAULT_EMBED_MODEL } = {}) {
  const chunks = buildChunksFromSegments(segments);
  const now = new Date().toISOString();
  const del = db.prepare(`DELETE FROM note_chunks WHERE note_id = ?`);
  const ins = db.prepare(
    `INSERT INTO note_chunks (note_id, chunk_idx, start_sec, end_sec, text, seg_start_idx, seg_end_idx, embedding, embed_model, created_at, updated_at)
     VALUES (@note_id, @chunk_idx, @start_sec, @end_sec, @text, @seg_start_idx, @seg_end_idx, NULL, @embed_model, @created_at, @updated_at)`
  );

  const tx = db.transaction(() => {
    del.run(noteId);
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      ins.run({
        note_id: noteId,
        chunk_idx: i,
        start_sec: c.start,
        end_sec: c.end,
        text: c.text,
        seg_start_idx: c.segStartIdx,
        seg_end_idx: c.segEndIdx,
        embed_model: embedModel,
        created_at: now,
        updated_at: now
      });
    }
  });
  tx();
  return chunks.length;
}

export async function semanticSearch(db, { query, fromIso = null, toIso = null, topK = 10, filters = null } = {}) {
  const q = (query ?? '').toString().trim();
  if (!q) return { query: q, model: DEFAULT_EMBED_MODEL, items: [] };

  // Embed query (normalized)
  const [qVec] = await embedTexts([q], { model: DEFAULT_EMBED_MODEL });
  const qTokens = tokenizeForCompare(q);
  const qNorm = normalizeComparableText(q);
  const qBigrams = bigrams(qTokens);

  const hasTime = !!(fromIso && toIso);
  const f = filters && typeof filters === 'object' ? filters : {};
  const where = [`n.status = 'ready'`];
  const args = [];
  if (hasTime) {
    where.push(`n.created_at >= ? AND n.created_at <= ?`);
    args.push(fromIso, toIso);
  }
  const folderId = (f.folder_id ?? '').toString().trim();
  const status = (f.status ?? '').toString().trim();
  const tag = (f.tag ?? '').toString().trim();
  const title = (f.title ?? '').toString().trim();
  const favorite = !!f.favorite;
  const hasWords = !!f.has_words;
  const dminRaw = f.duration_min_ms;
  const dmaxRaw = f.duration_max_ms;
  const dmin =
    typeof dminRaw === 'number' && Number.isFinite(dminRaw)
      ? dminRaw
      : typeof dminRaw === 'string' && dminRaw.trim() !== '' && Number.isFinite(Number(dminRaw))
        ? Number(dminRaw)
        : null;
  const dmax =
    typeof dmaxRaw === 'number' && Number.isFinite(dmaxRaw)
      ? dmaxRaw
      : typeof dmaxRaw === 'string' && dmaxRaw.trim() !== '' && Number.isFinite(Number(dmaxRaw))
        ? Number(dmaxRaw)
        : null;

  if (folderId) {
    where.push(`n.folder_id = ?`);
    args.push(folderId);
  }
  if (status) {
    where.push(`n.status = ?`);
    args.push(status);
  }
  if (favorite) {
    where.push(`n.is_favorite = 1`);
  }
  if (tag) {
    where.push(
      `EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ?)`
    );
    args.push(tag);
  }
  if (title) {
    where.push(`n.title LIKE ? ESCAPE '\\'`);
    const like = `%${title.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    args.push(like);
  }
  if (dmin !== null) {
    where.push(`n.duration_ms >= ?`);
    args.push(dmin);
  }
  if (dmax !== null) {
    where.push(`n.duration_ms <= ?`);
    args.push(dmax);
  }
  if (hasWords) {
    where.push(`EXISTS (SELECT 1 FROM note_segments ns WHERE ns.note_id = n.id AND ns.words_json != '')`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let rows = db
    .prepare(
      `SELECT nc.note_id, nc.chunk_idx AS seg_idx, nc.start_sec, nc.end_sec, nc.text, nc.embedding,
              n.title, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.language
       FROM note_chunks nc
       JOIN notes n ON n.id = nc.note_id
       ${whereSql}
       ORDER BY n.created_at DESC
       LIMIT 5000`
    )
    .all(...args);

  // If this is a fresh DB migration, note_segments may be empty for older notes.
  // Backfill segments from notes.segments_json (best-effort, lightweight).
  if (rows.length === 0) {
    backfillNoteChunksFromNotes(db, { fromIso, toIso, limitNotes: 500 });
    rows = db
      .prepare(
        `SELECT nc.note_id, nc.chunk_idx AS seg_idx, nc.start_sec, nc.end_sec, nc.text, nc.embedding,
                n.title, n.created_at, n.updated_at, n.status, n.error, n.duration_ms, n.language
         FROM note_chunks nc
         JOIN notes n ON n.id = nc.note_id
         ${whereSql}
         ORDER BY n.created_at DESC
         LIMIT 5000`
      )
      .all(...args);
  }

  // Find which need embeddings
  const toEmbed = [];
  const toEmbedIdx = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r.embedding || (Buffer.isBuffer(r.embedding) && r.embedding.length === 0)) {
      toEmbed.push((r.text ?? '').toString());
      toEmbedIdx.push(i);
    }
  }

  if (toEmbed.length) {
    const vecs = await embedTexts(toEmbed, { model: DEFAULT_EMBED_MODEL });
    const upd = db.prepare(
      `UPDATE note_chunks
       SET embedding = @embedding, embed_model = @embed_model, updated_at = @updated_at
       WHERE note_id = @note_id AND chunk_idx = @seg_idx`
    );
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      for (let j = 0; j < vecs.length; j += 1) {
        const i = toEmbedIdx[j];
        const r = rows[i];
        const v = vecs[j];
        const buf = float32ToBuffer(v);
        rows[i].embedding = buf;
        upd.run({
          note_id: r.note_id,
          seg_idx: r.seg_idx,
          embedding: buf,
          embed_model: DEFAULT_EMBED_MODEL,
          updated_at: now
        });
      }
    });
    tx();
  }

  const scored = [];
  for (const r of rows) {
    const v = bufferToFloat32(r.embedding);
    const sem = cosineSim(qVec, v);
    if (!Number.isFinite(sem) || sem <= 0) continue;

    const docText = (r.text ?? '').toString();
    const docTokens = tokenizeForCompare(docText);
    const docSet = new Set(docTokens);
    let hitCount = 0;
    for (const t of qTokens) if (docSet.has(t)) hitCount += 1;
    const overlap = qTokens.length ? hitCount / qTokens.length : 0; // 0..1

    const phraseHit = qNorm.length >= 6 && normalizeComparableText(docText).includes(qNorm);

    let bigramHits = 0;
    if (qBigrams.length) {
      const docBigramSet = new Set(bigrams(docTokens));
      for (const b of qBigrams) if (docBigramSet.has(b)) bigramHits += 1;
    }
    const bigramScore = qBigrams.length ? bigramHits / qBigrams.length : 0; // 0..1

    const score = 0.78 * sem + 0.18 * overlap + 0.04 * bigramScore + (phraseHit ? 0.08 : 0);
    scored.push({
      score,
      sem,
      overlap,
      note_id: r.note_id,
      seg_idx: r.seg_idx,
      start: Number(r.start_sec),
      end: Number(r.end_sec),
      text: (r.text ?? '').toString(),
      note: {
        id: r.note_id,
        title: (r.title ?? '').toString(),
        created_at: r.created_at,
        updated_at: r.updated_at,
        status: r.status,
        error: r.error,
        duration_ms: r.duration_ms,
        language: r.language
      }
    });
  }

  scored.sort((a, b) => b.score - a.score);
  // Diversity: cap how many chunks we take from the same note.
  const perNoteCap = clampInt(topK, 1, 50, 10) >= 12 ? 3 : 2;
  const kept = [];
  const perNote = new Map();
  const want = Math.max(1, Number(topK) || 10);
  for (const m of scored) {
    const c = perNote.get(m.note_id) ?? 0;
    if (c >= perNoteCap) continue;
    perNote.set(m.note_id, c + 1);
    kept.push(m);
    if (kept.length >= want) break;
  }
  let top = kept;

  // Optional cross-encoder rerank (more accurate but slower).
  const wantRerank = (process.env.VOICEVAULT_RERANK_CE ?? '').toString().trim() === '1';
  if (wantRerank && top.length > 1) {
    const maxCand = clampInt(process.env.VOICEVAULT_RERANK_CE_MAX, 2, 40, 16);
    const cand = top.slice(0, maxCand);
    try {
      const scores = await crossEncoderRerank(q, cand.map((x) => x.text), {
        model: process.env.VOICEVAULT_RERANK_CE_MODEL || ''
      });
      for (let i = 0; i < cand.length; i += 1) {
        cand[i].score = 0.45 * cand[i].score + 0.55 * (Number(scores[i]) || 0);
      }
      cand.sort((a, b) => b.score - a.score);
      top = cand.concat(top.slice(maxCand)).slice(0, want);
    } catch {
      // If model fails to load, fall back to fused heuristic.
    }
  }

  // Group by note
  const byNote = new Map();
  for (const m of top) {
    const id = m.note_id;
    if (!byNote.has(id)) {
      byNote.set(id, {
        ...m.note,
        matches: []
      });
    }
    byNote.get(id).matches.push({
      start: m.start,
      end: m.end,
      text: m.text,
      score: m.score
    });
  }

  return {
    query: q,
    model: DEFAULT_EMBED_MODEL,
    items: Array.from(byNote.values())
  };
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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt((value ?? '').toString(), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function backfillNoteSegmentsFromNotes(db, { fromIso = null, toIso = null, limitNotes = 500 } = {}) {
  const hasTime = !!(fromIso && toIso);
  const notes = db
    .prepare(
      `SELECT id, segments_json
       FROM notes
       WHERE status = 'ready'
         AND trim(segments_json) != ''
         ${hasTime ? 'AND created_at >= ? AND created_at <= ?' : ''}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...(hasTime ? [fromIso, toIso, limitNotes] : [limitNotes]));

  const del = db.prepare(`DELETE FROM note_segments WHERE note_id = ?`);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO note_segments (note_id, seg_idx, start_sec, end_sec, text, embedding, embed_model, updated_at)
     VALUES (@note_id, @seg_idx, @start_sec, @end_sec, @text, NULL, @embed_model, @updated_at)`
  );
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const n of notes) {
      const noteId = (n?.id ?? '').toString();
      if (!noteId) continue;
      const segments = safeParseSegments(n?.segments_json);
      if (!segments.length) continue;
      del.run(noteId);
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i];
        const start = Number(s?.start);
        const end = Number(s?.end);
        const text = (s?.text ?? '').toString().trim();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
        ins.run({
          note_id: noteId,
          seg_idx: i,
          start_sec: start,
          end_sec: end,
          text,
          embed_model: DEFAULT_EMBED_MODEL,
          updated_at: now
        });
      }
    }
  });
  tx();
}

function backfillNoteChunksFromNotes(db, { fromIso = null, toIso = null, limitNotes = 500 } = {}) {
  const hasTime = !!(fromIso && toIso);
  const notes = db
    .prepare(
      `SELECT id, segments_json
       FROM notes
       WHERE status = 'ready'
         AND trim(segments_json) != ''
         ${hasTime ? 'AND created_at >= ? AND created_at <= ?' : ''}
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(...(hasTime ? [fromIso, toIso, limitNotes] : [limitNotes]));

  const del = db.prepare(`DELETE FROM note_chunks WHERE note_id = ?`);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO note_chunks (note_id, chunk_idx, start_sec, end_sec, text, seg_start_idx, seg_end_idx, embedding, embed_model, updated_at)
     VALUES (@note_id, @chunk_idx, @start_sec, @end_sec, @text, @seg_start_idx, @seg_end_idx, NULL, @embed_model, @updated_at)`
  );
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    for (const n of notes) {
      const noteId = (n?.id ?? '').toString();
      if (!noteId) continue;
      const segments = safeParseSegments(n?.segments_json);
      if (!segments.length) continue;
      const chunks = buildChunksFromSegments(segments);
      if (!chunks.length) continue;
      del.run(noteId);
      for (let i = 0; i < chunks.length; i += 1) {
        const c = chunks[i];
        ins.run({
          note_id: noteId,
          chunk_idx: i,
          start_sec: c.start,
          end_sec: c.end,
          text: c.text,
          seg_start_idx: c.segStartIdx,
          seg_end_idx: c.segEndIdx,
          embed_model: DEFAULT_EMBED_MODEL,
          updated_at: now
        });
      }
    }
  });
  tx();
}

function safeParseSegments(segmentsJson) {
  const raw = (segmentsJson ?? '').toString().trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function safeStringifyWords(words) {
  if (!Array.isArray(words) || words.length === 0) return '';
  const safe = [];
  for (const w of words) {
    const start = Number(w?.start);
    const end = Number(w?.end);
    const word = (w?.word ?? w?.text ?? '').toString();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !word.trim()) continue;
    safe.push({ start, end, word });
  }
  if (safe.length === 0) return '';
  try {
    return JSON.stringify(safe);
  } catch {
    return '';
  }
}

