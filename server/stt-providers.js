/**
 * Canonical STT providers for voiceVault. Used by HTTP handlers and `transcribeAudioFile`.
 */

export function defaultSttProviderFromEnv() {
  const v = (process.env.VOICEVAULT_STT_PROVIDER ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (v === 'elevenlabs' || v === 'eleven_labs') return 'elevenlabs';
  return 'whisper';
}

/** Normalize client/body `stt_provider` plus env default. */
export function normalizeSttProvider(raw) {
  const s = (raw ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (s === 'elevenlabs' || s === 'eleven_labs') return 'elevenlabs';
  if (s === 'whisper') return 'whisper';
  return defaultSttProviderFromEnv();
}

/** Prefer an explicit value on the note row when valid; otherwise env default. */
export function sttProviderForAuthoritativeFinal(rowSttRaw) {
  const s = (rowSttRaw ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (s === 'elevenlabs' || s === 'eleven_labs') return 'elevenlabs';
  if (s === 'whisper') return 'whisper';
  return defaultSttProviderFromEnv();
}
