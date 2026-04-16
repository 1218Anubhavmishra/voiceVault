import { spawn } from 'node:child_process';
import path from 'node:path';

export async function transcribeAudioFile(audioPath, { model = 'small', language = '' } = {}) {
  const scriptPath = path.resolve(process.cwd(), 'server', 'transcribe.py');

  const args = [
    scriptPath,
    '--audio',
    audioPath,
    '--model',
    model
  ];
  if (language) {
    args.push('--language', language);
  }

  const { stdout, stderr, exitCode } = await run('python', args, {
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

  const text = (stdout ?? '').toString().trim();
  return text;
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

