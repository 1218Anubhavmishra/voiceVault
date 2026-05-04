import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

let _ffmpegBin;

/**
 * Resolve ffmpeg for spawned processes. Cursor/IDE and some services use a minimal PATH where
 * `ffmpeg` is missing even after winget install (PATH only refreshes in new shells).
 * Set `VOICEVAULT_FFMPEG` or `FFMPEG_PATH` to a full path when needed.
 */
export function ffmpegExecutable() {
  if (_ffmpegBin) return _ffmpegBin;
  _ffmpegBin = resolveFfmpegBinaryUncached();
  return _ffmpegBin;
}

function resolveFfmpegBinaryUncached() {
  const fromEnv = (process.env.VOICEVAULT_FFMPEG || process.env.FFMPEG_PATH || '')
    .toString()
    .trim()
    .replace(/^["']|["']$/g, '');
  if (fromEnv) {
    if (path.isAbsolute(fromEnv) && fs.existsSync(fromEnv)) return fromEnv;
    const rel = path.resolve(process.cwd(), fromEnv);
    if (fs.existsSync(rel)) return rel;
    return fromEnv;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch {
        // ignore
      }
    }
    try {
      const out = execFileSync('where.exe', ['ffmpeg'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('INFO:'));
      if (first && fs.existsSync(first)) return first;
    } catch {
      // ignore
    }
  }
  return 'ffmpeg';
}

/** Minimal valid 16 kHz mono s16le WAV (silence) for warmup when lavfi/ffmpeg is unavailable. */
function writeSilentPcmWav16kMono(outPath, durationSec) {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * Math.max(0.25, Number(durationSec) || 1));
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buf.writeUInt16LE(bytesPerSample, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(outPath, buf);
}

export async function transcribeAudioFile(audioPath, { model = 'small', language = '', provider = '' } = {}) {
  const scriptPath = path.resolve(process.cwd(), 'server', 'transcribe.py');
  const venvPythonWin = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe');
  const pythonCmd =
    process.platform === 'win32' && fs.existsSync(venvPythonWin) ? venvPythonWin : 'python';

  const dataDir = process.env.VV_DATA_DIR ? path.resolve(process.env.VV_DATA_DIR) : path.resolve(process.cwd(), 'data');

  // Preprocess audio via ffmpeg for better STT robustness (16kHz mono WAV).
  // Optional extra robustness: denoise + loudness normalization.
  const wantDenoise = (process.env.VOICEVAULT_DENOISE ?? '').toString().trim() === '1';
  const wantLoudnorm = (process.env.VOICEVAULT_LOUDNORM ?? '').toString().trim() !== '0';
  const wantHp = (process.env.VOICEVAULT_FFMPEG_SPEECH_HP ?? '').toString().trim() === '1';
  const preprocessedPath = path.resolve(
    dataDir,
    'audio',
    `__pre_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`
  );
  try {
    const af = [];
    if (wantHp) {
      af.push('highpass=f=80');
    }
    if (wantDenoise) {
      // Light denoise tuned for speech (kept conservative to avoid artifacts).
      af.push('afftdn=nf=-25');
    }
    if (wantLoudnorm) {
      // Gentle broadcast-style normalization.
      af.push('loudnorm=I=-16:LRA=11:TP=-1.5');
    }
    const args = [
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts',
      '-i',
      audioPath,
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      ...(af.length ? ['-af', af.join(',')] : []),
      '-c:a',
      'pcm_s16le',
      preprocessedPath
    ];
    await runFfmpeg(args, {
      env: process.env
    });
  } catch {
    // If ffmpeg preprocessing fails, fall back to original path.
  }

  const audioForStt = fs.existsSync(preprocessedPath) ? preprocessedPath : audioPath;
  void provider;

  const args = [
    scriptPath,
    '--audio',
    audioForStt,
    '--model',
    model,
    '--json'
  ];
  if (language) {
    args.push('--language', language);
  }

  const { stdout, stderr, exitCode } = await run(pythonCmd, args, {
    env: {
      ...process.env,
      PYTHONUTF8: '1'
    }
  });

  if (exitCode !== 0) {
    const hint =
      'Transcription failed. Install Python 3.10+, ffmpeg, then run: pip install -r server/requirements.txt';
    const msg = [hint, stderr?.trim()].filter(Boolean).join('\n');
    const err = new Error(msg);
    err.code = 'TRANSCRIBE_FAILED';
    throw err;
  }

  const raw = (stdout ?? '').toString().trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      transcript: (parsed?.transcript ?? '').toString().trim(),
      language: (parsed?.language ?? '').toString().trim(),
      segments: Array.isArray(parsed?.segments) ? parsed.segments : []
    };
  } catch {
    // Backward compatibility if python script is old / prints plain text
    return { transcript: raw, language: '', segments: [] };
  } finally {
    try {
      if (fs.existsSync(preprocessedPath)) fs.unlinkSync(preprocessedPath);
    } catch {
      // ignore
    }
  }
}

/** Same resolution as server pipeline (`WHISPER_LANG_MODEL` → `WHISPER_FAST_MODEL` → `WHISPER_MODEL` → small). */
export function whisperModelFromEnv() {
  return (
    process.env.WHISPER_LANG_MODEL ||
    process.env.WHISPER_FAST_MODEL ||
    process.env.WHISPER_MODEL ||
    'small'
  )
    .toString()
    .trim() || 'small';
}

/** Heavier / final-pass model for queued server transcription (defaults to same as `whisperModelFromEnv`). */
export function whisperFinalModelFromEnv() {
  const v = (process.env.WHISPER_FINAL_MODEL ?? '').toString().trim();
  if (v) return v;
  return whisperModelFromEnv();
}

/**
 * Load faster-whisper once at startup so the first user note pays less cold-start latency.
 * Set `VOICEVAULT_WHISPER_WARMUP=0` to skip (e.g. CI).
 */
export async function warmupWhisperPipeline() {
  const off = (process.env.VOICEVAULT_WHISPER_WARMUP ?? '').toString().trim() === '0';
  if (off) return;
  const dataDir = process.env.VV_DATA_DIR ? path.resolve(process.env.VV_DATA_DIR) : path.resolve(process.cwd(), 'data');
  const audioDir = path.join(dataDir, 'audio');
  try {
    fs.mkdirSync(audioDir, { recursive: true });
  } catch {
    // ignore
  }
  const tmpPath = path.join(audioDir, `__warm_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`);
  const { exitCode } = await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-t',
      '1.0',
      '-c:a',
      'pcm_s16le',
      tmpPath
    ],
    { env: process.env }
  );
  if (exitCode !== 0 || !fs.existsSync(tmpPath)) {
    try {
      writeSilentPcmWav16kMono(tmpPath, 1.0);
      // eslint-disable-next-line no-console
      console.warn(
        '[voicevault] whisper warmup: ffmpeg lavfi failed; using synthetic WAV so faster-whisper still loads (set VOICEVAULT_FFMPEG if real audio transcode fails too)'
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[voicevault] whisper warmup: no audio fixture:', e?.message ?? e);
      return;
    }
  }
  try {
    await transcribeAudioFile(tmpPath, {
      model: whisperModelFromEnv(),
      language: '',
      provider: 'whisper'
    });
    // eslint-disable-next-line no-console
    console.log('[voicevault] whisper warmup finished');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[voicevault] whisper warmup failed:', e?.message ?? e);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}

function runFfmpeg(args, opts = {}) {
  const bin = ffmpegExecutable();
  return run(bin, args, opts);
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

