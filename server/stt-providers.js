/**
 * Canonical STT providers for voiceVault. Used by HTTP handlers and `transcribeAudioFile`.
 */

function envSttProviderRaw() {
  const a = (process.env.VOICEVAULT_STT_PROVIDER ?? '').toString().trim();
  const b = (process.env.OICEVAULT_STT_PROVIDER ?? '').toString().trim();
  const v = (a || b).replace(/^["']|["']$/g, '');
  return v;
}

export function defaultSttProviderFromEnv() {
  const v = envSttProviderRaw().toLowerCase().replace(/-/g, '_');
  if (v === 'elevenlabs' || v === 'eleven_labs') return 'elevenlabs';
  // Default to ElevenLabs so transcript/segments generation does not depend on Whisper.
  return 'elevenlabs';
}

/** Normalize client/body `stt_provider` plus env default. */
export function normalizeSttProvider(raw) {
  const s = (raw ?? '')
    .toString()
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
    .replace(/-/g, '_');
  if (s === 'elevenlabs' || s === 'eleven_labs') return 'elevenlabs';
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
  return defaultSttProviderFromEnv();
}
