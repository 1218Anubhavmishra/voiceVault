/**
 * Google Cloud Speech-to-Text v2 with the Chirp family (default: chirp_3).
 * Regional endpoint + default recognizer `_`.
 *
 * Env:
 * - GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT (required)
 * - GOOGLE_APPLICATION_CREDENTIALS (service account JSON path, typical for local dev)
 * - VOICEVAULT_GOOGLE_STT_REGION (default: asia-south1)
 * - VOICEVAULT_GOOGLE_STT_MODEL (default: chirp_3)
 * - VOICEVAULT_GOOGLE_STT_LANGUAGE_CODES: comma-separated BCP-47 tags when language is unset/auto
 * - VOICEVAULT_GOOGLE_STT_MAX_SYNC_SECONDS: chunk size for sync Recognize (default: 55)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { v2, protos } from '@google-cloud/speech';

const AudioEncoding = protos.google.cloud.speech.v2.ExplicitDecodingConfig.AudioEncoding;

const DEFAULT_REGION = 'asia-south1';
const DEFAULT_MODEL = 'chirp_3';
/** Broad Indian-locale shortlist for multilingual prompts when language is not fixed. */
const DEFAULT_IN_LANG_CODES = [
  'hi-IN',
  'en-IN',
  'ta-IN',
  'te-IN',
  'bn-IN',
  'mr-IN',
  'gu-IN',
  'kn-IN',
  'ml-IN',
  'pa-IN',
  'ur-IN',
  'or-IN',
  'as-IN'
];

/** Map Whisper-style ISO 639-1 codes to likely Indian BCP-47 tags. */
const LANG_HINT_TO_BCP = {
  hi: 'hi-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  pa: 'pa-IN',
  bn: 'bn-IN',
  or: 'or-IN',
  as: 'as-IN',
  ur: 'ur-IN',
  en: 'en-IN',
  sa: 'sa-IN'
};

let _client;

function getProjectId() {
  const p =
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT_ID?.trim();
  if (!p) {
    throw new Error(
      'Google STT requires GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT (and GOOGLE_APPLICATION_CREDENTIALS for local auth).'
    );
  }
  return p;
}

function getRegion() {
  return (process.env.VOICEVAULT_GOOGLE_STT_REGION ?? DEFAULT_REGION).trim() || DEFAULT_REGION;
}

function getModel() {
  return (process.env.VOICEVAULT_GOOGLE_STT_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getMaxSyncSeconds() {
  const raw = (process.env.VOICEVAULT_GOOGLE_STT_MAX_SYNC_SECONDS ?? '55').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 5 ? Math.min(n, 300) : 55;
}

function parseLanguageCodes(languageHint) {
  const trimmed = (languageHint ?? '').trim().toLowerCase();
  const envList = (process.env.VOICEVAULT_GOOGLE_STT_LANGUAGE_CODES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (envList.length) return envList;

  if (!trimmed || trimmed === 'auto') return [...DEFAULT_IN_LANG_CODES];

  if (trimmed.includes('-')) return [trimmed];

  const mapped = LANG_HINT_TO_BCP[trimmed];
  if (mapped) return [mapped];

  return [...DEFAULT_IN_LANG_CODES];
}

function durationToSeconds(d) {
  if (d == null) return 0;
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  const secRaw = d.seconds ?? d.secs;
  const seconds = typeof secRaw === 'object' && secRaw?.toNumber ? secRaw.toNumber() : Number(secRaw ?? 0);
  const nanos = Number(d.nanos ?? 0);
  return seconds + nanos / 1e9;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function getSpeechClient() {
  if (_client) return _client;
  const region = getRegion();
  const apiEndpoint = `${region}-speech.googleapis.com`;
  _client = new v2.SpeechClient({ apiEndpoint });
  return _client;
}

function run(cmd, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.on('error', (e) =>
      resolve({ stdout, stderr: `${stderr}\n${e?.message ?? e}`, exitCode: 1 })
    );
  });
}

async function ffprobeDurationSeconds(filePath) {
  const { stdout, exitCode } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  if (exitCode !== 0) return 0;
  const n = parseFloat(String(stdout ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

function mapResponseToVoiceVaultShape(response, timeOffsetSec = 0) {
  const results = response?.results ?? [];
  const segments = [];
  const transcriptParts = [];
  let detectedLang = '';

  // Language may appear on any result (sometimes not on the first); gather before skipping empty transcripts.
  for (const res of results) {
    const lc = res.languageCode ?? res.language_code;
    if (lc && !detectedLang) detectedLang = String(lc);
  }

  for (const res of results) {
    const alt = res.alternatives?.[0];
    if (!alt) continue;
    const text = (alt.transcript ?? '').trim();
    if (!text) continue;

    const lc = res.languageCode ?? res.language_code;
    if (lc && !detectedLang) detectedLang = String(lc);

    const wordsOut = [];
    for (const w of alt.words ?? []) {
      const rawWord = (w.word ?? '').trim();
      if (!rawWord) continue;
      const ws = durationToSeconds(w.startOffset) + timeOffsetSec;
      const we = durationToSeconds(w.endOffset) + timeOffsetSec;
      if (we <= ws) continue;
      wordsOut.push({
        start: round3(Math.max(0, ws)),
        end: round3(Math.max(0, we)),
        word: rawWord
      });
    }

    let start = timeOffsetSec;
    let end = timeOffsetSec;
    if (wordsOut.length) {
      start = wordsOut[0].start;
      end = wordsOut[wordsOut.length - 1].end;
    } else if (res.resultEndOffset) {
      end = durationToSeconds(res.resultEndOffset) + timeOffsetSec;
    }

    transcriptParts.push(text);
    segments.push({
      start: round3(Math.max(0, start)),
      end: round3(Math.max(0, end)),
      text,
      words: wordsOut
    });
  }

  return {
    transcript: transcriptParts.join('\n\n').trim(),
    language: detectedLang,
    segments
  };
}

async function recognizeOnce(client, recognizerName, languageCodes, pcmBytes) {
  const req = {
    recognizer: recognizerName,
    config: {
      explicitDecodingConfig: {
        encoding: AudioEncoding.LINEAR16,
        sampleRateHertz: 16000,
        audioChannelCount: 1
      },
      model: getModel(),
      languageCodes,
      features: {
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true
      }
    },
    content: pcmBytes
  };
  const [response] = await client.recognize(req);
  return response;
}

/**
 * @param {string} wavPath - 16 kHz mono PCM WAV (matches ffmpeg preprocessing in transcribe.js)
 * @param {{ language?: string }} opts
 */
export async function transcribeWithGoogleChirp(wavPath, { language = '' } = {}) {
  const projectId = getProjectId();
  const region = getRegion();
  const client = getSpeechClient();
  const recognizerName = client.recognizerPath(projectId, region, '_');
  const languageCodes = parseLanguageCodes(language);

  const buf = fs.readFileSync(wavPath);
  const duration = await ffprobeDurationSeconds(wavPath);
  const maxSec = getMaxSyncSeconds();

  // One sync Recognize call: short clip, or unknown duration (ffprobe failed) — still under API size limits in practice.
  if (duration === 0 || duration <= maxSec) {
    const response = await recognizeOnce(client, recognizerName, languageCodes, buf);
    return mapResponseToVoiceVaultShape(response, 0);
  }

  const step = maxSec;

  const dataDir = process.env.VV_DATA_DIR
    ? path.resolve(process.env.VV_DATA_DIR)
    : path.resolve(process.cwd(), 'data');
  const tmpDir = path.join(dataDir, 'audio', `__gchunks_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const mergedSegments = [];
    const transcriptBlocks = [];
    let langOut = '';

    for (let offset = 0; offset < duration; offset += step) {
      const chunkPath = path.join(tmpDir, `chunk_${offset}.wav`);
      const remaining = Math.max(0, duration - offset);
      const slice = Math.min(step, remaining);
      if (slice <= 0) continue;
      const { exitCode, stderr } = await run(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(offset),
          '-i',
          wavPath,
          '-t',
          String(slice),
          '-vn',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          chunkPath
        ],
        { env: process.env }
      );
      if (exitCode !== 0) {
        const err = new Error(`ffmpeg chunk failed near offset ${offset}s:\n${stderr ?? ''}`);
        err.code = 'TRANSCRIBE_FAILED';
        throw err;
      }
      if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size < 64) continue;

      const chunkBuf = fs.readFileSync(chunkPath);
      const response = await recognizeOnce(client, recognizerName, languageCodes, chunkBuf);
      const part = mapResponseToVoiceVaultShape(response, offset);
      if (part.language) langOut = langOut || part.language;
      if (part.transcript) transcriptBlocks.push(part.transcript);
      mergedSegments.push(...part.segments);
    }

    return {
      transcript: transcriptBlocks.join('\n\n').trim(),
      language: langOut,
      segments: mergedSegments
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
