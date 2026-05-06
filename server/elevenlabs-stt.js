import fs from 'node:fs';
import path from 'node:path';

/** Map ElevenLabs ISO-639-3 (and occasional 2-letter) to note/UI 2-letter hints where we know them. */
const ISO639_3_TO_2 = {
  eng: 'en',
  hin: 'hi',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  jpn: 'ja',
  kor: 'ko',
  zho: 'zh',
  cmn: 'zh',
  ara: 'ar',
  rus: 'ru',
  nld: 'nl',
  pol: 'pl',
  tur: 'tr',
  vie: 'vi',
  tha: 'th',
  ind: 'id',
  tel: 'te',
  tam: 'ta',
  ben: 'bn',
  mar: 'mr',
  guj: 'gu',
  kan: 'kn',
  mal: 'ml',
  pan: 'pa',
  urd: 'ur',
  pes: 'fa',
  fas: 'fa',
  heb: 'he',
  ell: 'el',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  ces: 'cs',
  slk: 'sk',
  ron: 'ro',
  bul: 'bg',
  ukr: 'uk',
  hrv: 'hr',
  slv: 'sl',
  srp: 'sr',
  cat: 'ca',
  eus: 'eu',
  glg: 'gl',
  cym: 'cy',
  gle: 'ga',
  gla: 'gd',
  lit: 'lt',
  lav: 'lv',
  est: 'et',
  hun: 'hu',
  swa: 'sw',
  fil: 'tl',
  msa: 'ms',
  jav: 'jv',
  sun: 'su',
  nep: 'ne',
  sin: 'si',
  mya: 'my',
  khm: 'km',
  lao: 'lo',
  kat: 'ka',
  hye: 'hy',
  aze: 'az',
  kaz: 'kk',
  uzb: 'uz'
};

function elevenLabsLanguageToStored(code) {
  const c = (code ?? '').toString().trim().toLowerCase();
  if (!c) return '';
  if (c.length === 2) return c;
  if (c.length === 3) return ISO639_3_TO_2[c] || c;
  return c.slice(0, 3);
}

/**
 * Turn word-level STT output into segment rows compatible with Whisper/faster-whisper JSON.
 * @param {Array<{text?: string, start?: number, end?: number, type?: string}>} words
 * @returns {Array<{start: number, end: number, text: string}>}
 */
function wordsToSegments(words) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const list = [];
  for (const w of words) {
    if (!w || typeof w.text !== 'string') continue;
    const s = Number(w.start);
    const e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    list.push({ text: w.text, start: s, end: e });
  }
  if (!list.length) return [];
  list.sort((a, b) => a.start - b.start || a.end - b.end);
  const GAP_SEC = 1.2;
  const out = [];
  let cur = { start: list[0].start, end: list[0].end, parts: [list[0].text] };
  for (let i = 1; i < list.length; i++) {
    const w = list[i];
    const gap = w.start - cur.end;
    if (gap > GAP_SEC) {
      const text = cur.parts.join('').replace(/\s+/g, ' ').trim();
      if (text) out.push({ start: cur.start, end: cur.end, text });
      cur = { start: w.start, end: w.end, parts: [w.text] };
    } else {
      cur.end = Math.max(cur.end, w.end);
      cur.parts.push(w.text);
    }
  }
  const lastText = cur.parts.join('').replace(/\s+/g, ' ').trim();
  if (lastText) out.push({ start: cur.start, end: cur.end, text: lastText });
  return out;
}

/**
 * @param {string} audioPath - path to audio file (e.g. 16 kHz WAV after ffmpeg)
 * @param {{ language?: string }} opts - optional ISO-639-1 hint (matches UI / Whisper)
 * @returns {Promise<{ transcript: string, language: string, segments: Array<{start:number,end:number,text:string}> }>}
 */
export async function transcribeAudioWithElevenLabs(audioPath, { language = '' } = {}) {
  const key = (process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '').toString().trim();
  if (!key) {
    const err = new Error('ELEVENLABS_API_KEY is not set (required for ElevenLabs STT)');
    err.code = 'ELEVENLABS_KEY_MISSING';
    throw err;
  }

  const base = (process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io').toString().replace(/\/$/, '');
  const url = `${base}/v1/speech-to-text`;
  const modelId = (process.env.ELEVENLABS_STT_MODEL || 'scribe_v1').toString().trim() || 'scribe_v1';

  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.set('model_id', modelId);
  form.set('file', new Blob([buf]), path.basename(audioPath) || 'audio.wav');
  form.set('timestamps_granularity', 'word');
  form.set('tag_audio_events', 'false');
  const lang = (language ?? '').toString().trim();
  if (lang) form.set('language_code', lang);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form
  });

  const rawText = await res.text();
  if (!res.ok) {
    let detail = rawText.slice(0, 800);
    try {
      const j = JSON.parse(rawText);
      const d = j?.detail;
      if (Array.isArray(d) && d[0]?.msg) detail = String(d[0].msg);
      else if (typeof j?.message === 'string') detail = j.message;
      else if (typeof j?.error === 'string') detail = j.error;
    } catch {
      // keep detail
    }
    const err = new Error(`ElevenLabs STT failed (${res.status}): ${detail}`);
    err.code = 'ELEVENLABS_STT_FAILED';
    throw err;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const err = new Error('ElevenLabs STT: response was not JSON');
    err.code = 'ELEVENLABS_STT_FAILED';
    throw err;
  }

  if (data?.message && data?.request_id && !data?.text) {
    const err = new Error('ElevenLabs STT returned an async/webhook response; set webhook=false on file uploads.');
    err.code = 'ELEVENLABS_STT_ASYNC';
    throw err;
  }

  const chunk = Array.isArray(data?.transcripts) ? data.transcripts[0] : data;
  if (!chunk || typeof chunk.text !== 'string') {
    const err = new Error('ElevenLabs STT: missing transcript text in response');
    err.code = 'ELEVENLABS_STT_FAILED';
    throw err;
  }

  const transcript = chunk.text.trim();
  const langOut = elevenLabsLanguageToStored(chunk.language_code || '');
  let segments = wordsToSegments(Array.isArray(chunk.words) ? chunk.words : []);
  if (!segments.length && transcript) {
    const dur = Number(chunk.audio_duration_secs);
    const end = Number.isFinite(dur) && dur > 0 ? dur : Math.max(0.5, transcript.length * 0.06);
    segments = [{ start: 0, end, text: transcript.replace(/\s+/g, ' ').trim() }];
  }

  return { transcript, language: langOut, segments };
}
