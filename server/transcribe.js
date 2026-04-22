import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export async function transcribeAudioFile(audioPath, { model = 'small', language = '' } = {}) {
  const scriptPath = path.resolve(process.cwd(), 'server', 'transcribe.py');
  const venvPythonWin = path.resolve(process.cwd(), '.venv', 'Scripts', 'python.exe');
  const pythonCmd =
    process.platform === 'win32' && fs.existsSync(venvPythonWin) ? venvPythonWin : 'python';

  const args = [
    scriptPath,
    '--audio',
    audioPath,
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
      language: (parsed?.language ?? '').toString().trim()
    };
  } catch {
    // Backward compatibility if python script is old / prints plain text
    return { transcript: raw, language: '' };
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

