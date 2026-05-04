import fs from 'node:fs';
import path from 'node:path';

/**
 * Remove leftover STT/upload scratch files so restarts do not accumulate garbage under `data/`.
 * Safe: only `data/audio` entries whose names start with `__`, orphan `import_*_staging` dirs,
 * and old zip uploads under `data/imports` (mtime; skips very recent files).
 *
 * @param {{ dataDir: string, audioDir: string }} paths
 * @returns {{ audio_files: number, audio_dirs: number, import_zips: number, staging_dirs: number }}
 */
export function cleanupEphemeralServerCache(paths) {
  const stats = { audio_files: 0, audio_dirs: 0, import_zips: 0, staging_dirs: 0 };
  const { dataDir, audioDir } = paths;
  if (!dataDir || !audioDir) return stats;

  try {
    if (fs.existsSync(audioDir)) {
      for (const name of fs.readdirSync(audioDir)) {
        if (!name.startsWith('__')) continue;
        const full = path.join(audioDir, name);
        try {
          const st = fs.lstatSync(full);
          if (st.isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
            stats.audio_dirs += 1;
          } else {
            fs.unlinkSync(full);
            stats.audio_files += 1;
          }
        } catch {
          // ignore per entry
        }
      }
    }
  } catch {
    // ignore
  }

  const importsDir = path.join(dataDir, 'imports');
  const maxAgeMin = Math.max(1, Number(process.env.VOICEVAULT_IMPORT_ZIP_MAX_AGE_MIN ?? '60') || 60);
  const cutoffMs = Date.now() - maxAgeMin * 60_000;
  try {
    if (fs.existsSync(importsDir)) {
      for (const name of fs.readdirSync(importsDir)) {
        if (!name.toLowerCase().endsWith('.zip')) continue;
        const full = path.join(importsDir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          if (st.mtimeMs > cutoffMs) continue;
          fs.unlinkSync(full);
          stats.import_zips += 1;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    if (fs.existsSync(dataDir)) {
      for (const name of fs.readdirSync(dataDir)) {
        if (!/^import_.+_staging$/i.test(name)) continue;
        const full = path.join(dataDir, name);
        try {
          const st = fs.lstatSync(full);
          if (!st.isDirectory()) continue;
          fs.rmSync(full, { recursive: true, force: true });
          stats.staging_dirs += 1;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  return stats;
}
