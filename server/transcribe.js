import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { transcribeAudioWithElevenLabs } from './elevenlabs-stt-vv.js';

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

/**
 * Transcription is ElevenLabs STT only (`transcribeAudioWithElevenLabs`).
 * The `model` / `provider` arguments are ignored and kept only for backwards-compatible call sites.
 */
export async function transcribeAudioFile(audioPath, { model = '', language = '', provider = '' } = {}) {
  void model;
  void provider;

  const dataDir = process.env.VV_DATA_DIR ? path.resolve(process.env.VV_DATA_DIR) : path.resolve(process.cwd(), 'data');

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
      af.push('afftdn=nf=-25');
    }
    if (wantLoudnorm) {
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

  const rejectSilence = (process.env.VOICEVAULT_REJECT_SILENCE ?? '1').toString().trim() !== '0';
  if (rejectSilence) {
    try {
      const silent = await isLikelySilentAudio(audioForStt);
      if (silent) {
        const err = new Error(
          'Audio appears silent or muted. Unmute your microphone / pick the correct input device, then record again.'
        );
        err.code = 'AUDIO_SILENT';
        throw err;
      }
    } catch (e) {
      if ((e?.code ?? '') === 'AUDIO_SILENT') throw e;
    }
  }

  try {
    return await transcribeAudioWithElevenLabs(audioForStt, { language: (language ?? '').toString() });
  } finally {
    try {
      if (fs.existsSync(preprocessedPath)) fs.unlinkSync(preprocessedPath);
    } catch {
      // ignore
    }
  }
}

/** No-op: legacy Whisper warmup removed — STT is ElevenLabs-only. */
export async function warmupWhisperPipeline() {
  return;
}

/** @deprecated Kept only for accidental imports; transcription does not use Whisper. */
export function whisperModelFromEnv() {
  return '';
}

/** @deprecated Kept only for accidental imports; transcription does not use Whisper. */
export function whisperFinalModelFromEnv() {
  return '';
}

function runFfmpeg(args, opts = {}) {
  const bin = ffmpegExecutable();
  return run(bin, args, opts);
}

/**
 * First ~N seconds as 16 kHz mono WAV for cheap language detection (avoids full-file STT on long uploads).
 */
export async function writeLangProbeWavClip(sourcePath, destPath, maxSeconds = 55) {
  const lim = Math.max(12, Math.min(180, Number(maxSeconds) || 55));
  const { exitCode } = await runFfmpeg(
    [
      '-nostdin',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts',
      '-i',
      sourcePath,
      '-t',
      String(lim),
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      destPath
    ],
    { env: process.env }
  );
  return exitCode === 0 && fs.existsSync(destPath);
}

async function isLikelySilentAudio(audioPath) {
  const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const { exitCode, stderr } = await runFfmpeg(
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      audioPath,
      '-vn',
      '-af',
      'volumedetect',
      '-f',
      'null',
      nullSink
    ],
    { env: process.env }
  );
  if (exitCode !== 0) return false;
  const s = (stderr ?? '').toString();
  if (!s) return false;
  if (/max_volume:\s*-inf/i.test(s) || /mean_volume:\s*-inf/i.test(s)) return true;

  const maxM = s.match(/max_volume:\s*([-\d.]+)\s*dB/i);
  const meanM = s.match(/mean_volume:\s*([-\d.]+)\s*dB/i);
  const maxDb = maxM ? Number(maxM[1]) : NaN;
  const meanDb = meanM ? Number(meanM[1]) : NaN;
  if (!Number.isFinite(maxDb) && !Number.isFinite(meanDb)) return false;

  if (Number.isFinite(maxDb) && maxDb <= -45) return true;
  if (Number.isFinite(meanDb) && meanDb <= -55) return true;
  return false;
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
