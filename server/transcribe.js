import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export async function transcribeAudioFile(audioPath, { model = 'small', language = '' } = {}) {
  const scriptPath = path.resolve(process.cwd(), 'server', 'transcribe.py');
  const venvPythonWin = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe');
  const pythonCmd =
    process.platform === 'win32' && fs.existsSync(venvPythonWin) ? venvPythonWin : 'python';

  const dataDir = process.env.VV_DATA_DIR ? path.resolve(process.env.VV_DATA_DIR) : path.resolve(process.cwd(), 'data');

  // Preprocess audio via ffmpeg for better STT robustness (16kHz mono WAV).
  // Optional extra robustness: denoise + loudness normalization.
  const wantDenoise = (process.env.VOICEVAULT_DENOISE ?? '').toString().trim() === '1';
  const wantLoudnorm = (process.env.VOICEVAULT_LOUDNORM ?? '').toString().trim() !== '0';
  const preprocessedPath = path.resolve(
    dataDir,
    'audio',
    `__pre_${Date.now()}_${Math.random().toString(16).slice(2)}.wav`
  );
  try {
    const af = [];
    if (wantDenoise) {
      // Light denoise tuned for speech (kept conservative to avoid artifacts).
      af.push('afftdn=nf=-25');
    }
    if (wantLoudnorm) {
      // Gentle broadcast-style normalization.
      af.push('loudnorm=I=-16:LRA=11:TP=-1.5');
    }
    const args = [
      '-y',
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
    await run('ffmpeg', args, {
      env: process.env
    });
  } catch {
    // If ffmpeg preprocessing fails, fall back to original path.
  }

  const args = [
    scriptPath,
    '--audio',
    fs.existsSync(preprocessedPath) ? preprocessedPath : audioPath,
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

