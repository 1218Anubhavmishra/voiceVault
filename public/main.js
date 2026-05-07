const statusEl = document.getElementById('status');
const btnRecordNote = document.getElementById('btnRecordNote');
const btnStopNote = document.getElementById('btnStopNote');
const btnSaveNote = document.getElementById('btnSaveNote');
const newNoteProcessingRowEl = document.getElementById('newNoteProcessingRow');
const newNoteProcessingTimeEl = document.getElementById('newNoteProcessingTime');
const newNoteProcLabelEl = document.getElementById('newNoteProcLabel');
const previewNote = document.getElementById('previewNote');
const titleEl = document.getElementById('title');
const noteTimerEl = document.getElementById('noteTimer');
const noteDetectedLangEl = document.getElementById('noteDetectedLang');
const noteLanguageWrapEl = document.getElementById('noteLanguageWrap');
const noteLanguageEl = document.getElementById('noteLanguage');
const noteLangCountdownWrapEl = document.getElementById('noteLangCountdownWrap');
const noteLangCountdownPillEl = document.getElementById('noteLangCountdownPill');
const uploadNoteEl = document.getElementById('uploadNote');
const uploadNoteBtnEl = document.getElementById('uploadNoteBtn');
const uploadNoteNameEl = document.getElementById('uploadNoteName');
const liveTranscriptEl = document.getElementById('liveTranscript');
const liveTranscriptWrapEl = document.getElementById('liveTranscriptWrap');
const liveTxUpEl = document.getElementById('liveTxUp');
const liveTxDownEl = document.getElementById('liveTxDown');
const liveTxStatusEl = document.getElementById('liveTxStatus');
const liveTxTimeLeftEl = document.getElementById('liveTxTimeLeft');
const liveTxScrollRowEl = document.getElementById('liveTxScrollRow');
const newNoteTxStageRowEl = document.getElementById('newNoteTxStageRow');
const newNoteStageLiveEl = document.getElementById('newNoteStageLive');
const newNoteStageFullEl = document.getElementById('newNoteStageFull');
const liveTxPhaseLabelEl = document.getElementById('liveTxPhaseLabel');
const liveTxLangStatusEl = document.getElementById('liveTxLangStatus');

/** Resolves when post-record/upload transcription pipeline (live drain + full preview) has finished. */
let notePostRecordPipelinePromise = null;
let noteTranscriptionPipelineBusy = false;

function setLiveTxPhaseLabel(text) {
  if (liveTxPhaseLabelEl) liveTxPhaseLabelEl.textContent = (text ?? '').toString() || '—';
}

function setNewNoteTranscriptionStages({ live = 'pending', full = 'pending', showRow = true } = {}) {
  const show =
    !!showRow &&
    (!!note.audioBlob || note.isRecording) &&
    (note.isRecording || live === 'active' || full === 'active' || live === 'done' || full === 'done' || live === 'skipped');
  if (newNoteTxStageRowEl) newNoteTxStageRowEl.hidden = !show;
  if (newNoteStageLiveEl) {
    newNoteStageLiveEl.dataset.state = live;
    newNoteStageLiveEl.textContent = live === 'skipped' ? 'Live Transcript (n/a — file)' : 'Live Transcript';
  }
  if (newNoteStageFullEl) newNoteStageFullEl.dataset.state = full;
}

async function runNotePostRecordTranscriptionPipeline(source) {
  // Do not gate on `note.isRecording`: the recorder `stop` handler sets `audioBlob` in the same
  // turn as `isRecording = false`; an `isRecording` check can race and skip work entirely.
  if (!note.audioBlob) return;
  noteTranscriptionPipelineBusy = true;
  try {
    const afterRecording = source === 'recording_stop';
    const fromUpload = source === 'upload';

    if (afterRecording) {
      setNewNoteTranscriptionStages({
        live: 'active',
        full: 'pending',
        showRow: true
      });
      setLiveTxPhaseLabel('Live Transcription');
      if (liveTxStatusEl) liveTxStatusEl.hidden = false;
      await note.liveTranscribeTail.catch(() => {});
      setNewNoteTranscriptionStages({ live: 'done', full: 'pending', showRow: true });
    } else if (fromUpload) {
      setNewNoteTranscriptionStages({ live: 'skipped', full: 'pending', showRow: true });
      if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
    }

    clearLiveTxPreviewCountdown();
    if (liveTxStatusEl) liveTxStatusEl.hidden = true;
    setLiveTxPhaseLabel('Language');
    // Full-file `/api/detect-language` can take minutes on long clips; do not block the UI or Save
    // on it. Manual language (or any non–auto-detect hint) is enough to enable Generate immediately.
    void detectLanguageForNotePreview().catch(() => {});
    updateGenerateFullPreviewButtonVisibility();
    syncLiveTxScrollRowVisibility();
  } finally {
    noteTranscriptionPipelineBusy = false;
    scheduleServerNoteDraftBackup();
    syncVisibility();
  }
}

function syncLiveTxScrollRowVisibility() {
  if (!liveTxScrollRowEl || !liveTxStatusEl) return;
  const processing = !liveTxStatusEl.hidden;
  const hasText = !!(liveTranscriptEl && String(liveTranscriptEl.value ?? '').trim());
  liveTxScrollRowEl.hidden = processing || !hasText;
}

const qEl = document.getElementById('q');
const btnSearch = document.getElementById('btnSearch');
const btnRecordQuery = document.getElementById('btnRecordQuery');
const btnStopQuery = document.getElementById('btnStopQuery');
const previewQuery = document.getElementById('previewQuery');
const resultsEl = document.getElementById('results');
const searchCardEl = document.getElementById('searchCard');
const searchBodyEl = document.getElementById('searchBody');
const btnSearchCloseEl = document.getElementById('btnSearchClose');
const btnFloatSearchEl = document.getElementById('btnFloatSearch');
const queryTimerEl = document.getElementById('queryTimer');
const newNoteCardEl = document.getElementById('newNoteCard');
const btnHelpToggleEl = document.getElementById('btnHelpToggle');
const helpBodyEl = document.getElementById('helpBody');
const answerWrapEl = document.getElementById('answerWrap');
const semanticModeDotEl = document.getElementById('semanticModeDot'); // legacy; may be null
const btnAskEl = document.getElementById('btnAsk'); // removed from UI
const btnSemanticToggleEl = document.getElementById('btnSemanticToggle'); // removed from UI
const askModeEl = document.getElementById('askMode'); // removed from UI
const btnAdvancedSearchToggleEl = document.getElementById('btnAdvancedSearchToggle'); // removed from UI
const advancedSearchBodyEl = document.getElementById('advancedSearchBody'); // removed from UI
const advancedSearchCardEl = document.getElementById('advancedSearchCard'); // removed from UI
const btnNewNoteToggleEl = document.getElementById('btnNewNoteToggle');
const newNoteBodyEl = document.getElementById('newNoteBody');
const mainGridEl = document.getElementById('mainGrid');
const btnIngestPauseEl = document.getElementById('btnIngestPause');
const btnIngestResumeEl = document.getElementById('btnIngestResume');
const btnProcessesCloseEl = document.getElementById('btnProcessesClose');
const procBodyEl = document.getElementById('procBody');
const processCardEl = document.getElementById('processCard');
const floatDockEl = document.getElementById('floatDock');
const btnFloatProcessesEl = document.getElementById('btnFloatProcesses');
const btnFloatNewNoteEl = document.getElementById('btnFloatNewNote');
const btnFloatHelpEl = document.getElementById('btnFloatHelp');
const helpCardEl = document.getElementById('helpCard');
const btnHelpCloseEl = document.getElementById('btnHelpClose');
const jobsListEl = document.getElementById('jobsList');
const jobsPausedPillEl = document.getElementById('jobsPausedPill');
const jobsSummaryEl = document.getElementById('jobsSummary');
const jobsFiltersEl = document.getElementById('jobsFilters');
const jobsStatusFilterEl = document.getElementById('jobsStatusFilter');
const jobsMaxParallelEl = document.getElementById('jobsMaxParallel');
const btnJobsApplyEl = document.getElementById('btnJobsApply');
const jobsBackoffBaseSecEl = document.getElementById('jobsBackoffBaseSec');
const jobsBackoffMaxSecEl = document.getElementById('jobsBackoffMaxSec');
const btnJobsRetryAllEl = document.getElementById('btnJobsRetryAll');
const btnJobsUnlockNowEl = document.getElementById('btnJobsUnlockNow');

/** Shared inline SVGs for icon toolbar buttons (`currentColor`, 24×24). */
const VV_ICON_SVG = {
  save: `<svg class="vvIcon vvIcon--save" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4ZM5 19V9h14v10H5Zm8-4h4v-4h-4v4ZM7 7h8v6H7V7Z"/></svg>`,
  stop: `<svg class="vvIcon vvIcon--stop" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>`,
  play: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 5v14l11-7-11-7z"/></svg>`,
  playSegment: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm-2 14.5v-9l7 4.5-7 4.5Z"/></svg>`,
  arrowLeft: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M14 7 9 12l5 5 1.41-1.41L11.83 12l3.58-3.59L14 7z"/></svg>`,
  chevronDown: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`,
  chevronUp: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6 1.41 1.41z"/></svg>`,
  starOn: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`,
  starOff: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24Zm-10 6.15-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.02 4.38.38-3.32 2.88 1 4.28L12 15.39Z"/></svg>`,
  download: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 20h14v-2H5v2Zm7-18a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4.01 4a1 1 0 0 1-1.38 0l-4.01-4a1 1 0 1 1 1.4-1.42l2.3 2.3V3a1 1 0 0 1 1-1Z"/></svg>`,
  doc: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Zm0-8h5v2H8V8Z"/></svg>`,
  edit: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm2.92 2.83H5v-.92l9.06-9.06.92.92L5.92 20.08ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>`,
  applyTick: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" clip-rule="evenodd"/></svg>`,
  cancel: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
  delete: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4zm-10 10h2v5h-2v-5zm4 0h2v5h-2v-5z"/></svg>`,
  reprocess: `<svg class="vvIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4 8 8 0 1 0 14.05 19.7l-1.43-1.43A6 6 0 1 1 12 6c1.62 0 3.12.65 4.24 1.76L13 11h7V4l-2.35 2.35z"/></svg>`
};

const jobDetailsOverlayEl = document.getElementById('jobDetailsOverlay');
const jobDetailsPreEl = document.getElementById('jobDetailsPre');
const btnJobDetailsCloseEl = document.getElementById('btnJobDetailsClose');
const btnJobDetailsCopyEl = document.getElementById('btnJobDetailsCopy');

// Advanced search UI elements removed from index.html:
const libFolderFilterEl = null;
const libTagFilterEl = null;
const libStatusFilterEl = null;
const libFavOnlyEl = null;
const libManageMetaEl = null;
const savedSearchSelectEl = null;
const btnSaveSearchEl = null;
const metaManageOverlayEl = null;
const btnMetaManageCloseEl = null;
const metaNewFolderNameEl = null;
const btnMetaAddFolderEl = null;
const metaFoldersListEl = null;
const metaNewTagNameEl = null;
const btnMetaAddTagEl = null;
const metaTagsListEl = null;
const importZipEl = null;
const btnChooseImportZipEl = null;
const importZipNameEl = null;
const btnImportZipEl = null;

const AUDIO_BITS_PER_SECOND = 64_000; // 64 kbps Opus (WebM); adjust if you want higher quality
const MEDIARECORDER_TIMESLICE_MS = 100; // 0.1s chunks (recording only)
const LIVE_LANG_DETECT_INTERVAL_MS = 2000; // practical Whisper polling cadence
const LIVE_TRANSCRIBE_INTERVAL_MS = 3000; // live transcript preview cadence
/** Min recent-audio blob size before calling live STT (smaller clips still get previews sooner). */
const LIVE_TRANSCRIBE_MIN_CHUNK_BYTES = 12_000;
/**
 * Max wall-clock span represented in one live STT blob (MediaRecorder timeslices are ~100ms).
 * Capped under 12s: longer sliding windows were dropping the WebM init chunk and breaking decode.
 */
const LIVE_TRANSCRIBE_MAX_WINDOW_MS = 11_500;
/** Shorter window for /api/detect-language polling while recording. */
const LIVE_LANG_PROBE_MAX_WINDOW_MS = 8000;
/** If auto language detection does not open the language row first, show a countdown then reveal the list. */
const NOTE_LANG_AUTODETECT_COUNTDOWN_SEC = 30;

let noteLangCountdownIntervalId = null;
let noteLangCountdownEndsAt = 0;

/**
 * WebM from MediaRecorder is an init chunk plus cluster fragments. Using only `chunks.slice(-N)`
 * drops the EBML/CodecPrivate header once recording exceeds N×timeslice, so ffmpeg/STT get corrupt
 * input and Whisper returns nonsense. Always keep `chunks[0]` and cap tail length by time window.
 * @param {{ chunks?: BlobPart[], mediaRecorder?: MediaRecorder|null }} state
 * @param {number} maxWindowMs
 * @returns {Blob|null}
 */
function buildSlidingWebmBlobForLiveStt(state, maxWindowMs) {
  const chunks = state.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const mime = state.mediaRecorder?.mimeType || 'audio/webm';
  const sliceMs = Math.max(1, Number(MEDIARECORDER_TIMESLICE_MS) || 100);
  const maxPieces = Math.max(2, Math.ceil(Math.max(0, Number(maxWindowMs) || 0) / sliceMs));
  if (chunks.length <= maxPieces) {
    return new Blob(chunks, { type: mime });
  }
  const head = chunks[0];
  const tail = chunks.slice(-(maxPieces - 1));
  return new Blob([head, ...tail], { type: mime });
}

/** Mirror `server/index.js` `formatTranscript` so preview-bundle validation matches. */
function vvFormatTranscript(text) {
  const raw = (text ?? '').toString();
  if (!raw) return '';
  return raw
    .replaceAll('\u201c', '"')
    .replaceAll('\u201d', '"')
    .replaceAll('"', '\n"\n')
    .replace(/([.!?;:,])(?=\s*[\p{L}\p{N}])/gu, '$1\n')
    .replaceAll('\r\n', '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

/** Same rules as `sanitizeSegmentsForPersistence` on the server (preview bundle must pass save validation). */
function vvSanitizePreviewSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = (s?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    out.push({ start, end, text });
    if (out.length >= 8000) break;
  }
  return out;
}

function vvTranscriptFromSegments(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((s) => (s?.text ?? '').toString().trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Wall-clock STT vs recording length (very approximate; GPU/local Whisper varies). Used only for UI estimate. */
const PROCESSING_TIME_ESTIMATE_RATIO = 0.45;

/** Synced from `GET /api/client-config` so it matches `VOICEVAULT_STT_PROVIDER` on the server. */
let serverPreferredSttProvider = 'whisper';

async function refreshServerPreferredSttProvider() {
  try {
    const r = await fetch('/api/client-config');
    if (!r.ok) return;
    const j = await r.json();
    const p = (j?.stt_provider ?? '').toString().trim().toLowerCase();
    serverPreferredSttProvider = p === 'elevenlabs' ? 'elevenlabs' : 'whisper';
  } catch {
    // keep prior value
  }
}

function getNewNoteSttProvider() {
  return serverPreferredSttProvider;
}

/** Restore last language choice from localStorage (empty string = Auto-detect was chosen). */
function applyStickyNoteLanguageFromStorage() {
  if (!noteLanguageEl) return;
  try {
    const raw = localStorage.getItem('vv_last_note_language');
    if (raw === null) return;
    noteLanguageEl.value = (raw ?? '').toString().trim();
  } catch {
    // ignore
  }
}

function primaryLanguageCode(raw) {
  const s = (raw ?? '').toString().trim().toLowerCase();
  if (!s || s === 'und' || s === 'unknown') return '';
  const p = s.replaceAll('_', '-').split('-')[0] ?? '';
  return p.slice(0, 3);
}

function mapApiLanguageToSelectValue(raw) {
  const p = primaryLanguageCode(raw);
  if (!p) return '';
  const opt = NOTE_LANGUAGE_OPTIONS.find((o) => o.value && o.value === p);
  return opt ? opt.value : '';
}

function stopNoteLangDetectCountdown() {
  if (noteLangCountdownIntervalId != null) {
    clearInterval(noteLangCountdownIntervalId);
    noteLangCountdownIntervalId = null;
  }
  noteLangCountdownEndsAt = 0;
}

function updateNoteLangDetectCountdownTick() {
  if (noteLanguageWrapEl && !noteLanguageWrapEl.hidden) {
    stopNoteLangDetectCountdown();
    return;
  }
  const rem = Math.max(0, Math.ceil((noteLangCountdownEndsAt - Date.now()) / 1000));
  if (noteDetectedLangEl) {
    noteDetectedLangEl.hidden = false;
    noteDetectedLangEl.textContent = `Auto-detect language in ${rem}s`;
  }
  if (rem <= 0) {
    stopNoteLangDetectCountdown();
    revealNoteLanguageWrap();
    syncLiveTxLangHeader();
    updateGenerateFullPreviewButtonVisibility();
    syncVisibility();
  }
}

/** While the language row is hidden, show a 30s countdown then reveal the row for manual choice. */
function startNoteLangDetectCountdown() {
  if (noteLanguageWrapEl && !noteLanguageWrapEl.hidden) {
    stopNoteLangDetectCountdown();
    return;
  }
  stopNoteLangDetectCountdown();
  noteLangCountdownEndsAt = Date.now() + NOTE_LANG_AUTODETECT_COUNTDOWN_SEC * 1000;
  updateNoteLangDetectCountdownTick();
  noteLangCountdownIntervalId = setInterval(updateNoteLangDetectCountdownTick, 250);
}

function revealNoteLanguageWrap() {
  if (noteLanguageWrapEl) noteLanguageWrapEl.hidden = false;
  stopNoteLangDetectCountdown();
  syncLiveTxLangHeader();
}

/** Sync pill + dropdown from `/api/detect-language` (or live probe) result. */
function applyDetectedLanguageToPillAndSelect(apiLang) {
  const raw = (apiLang ?? '').toString().trim();
  if (!raw) return;
  noteLastDetectedApiLang = raw;
  const selectVal = mapApiLanguageToSelectValue(raw);
  const meta = formatNoteLanguageMeta(raw) || selectVal || raw;
  if (noteDetectedLangEl) {
    noteDetectedLangEl.hidden = false;
    noteDetectedLangEl.textContent = meta ? `Lang: ${meta}` : 'Lang: —';
  }
  revealNoteLanguageWrap();
  const prevSelect = (noteLanguageEl?.value ?? '').toString().trim();
  if (noteLanguageEl) {
    noteLangProgrammatic = true;
    noteLanguageEl.value = selectVal;
    noteLangProgrammatic = false;
    try {
      localStorage.setItem('vv_last_note_language', selectVal);
    } catch {
      // ignore
    }
  }
  const nextSelect = (noteLanguageEl?.value ?? '').toString().trim();
  if (note.audioBlob && !note.isRecording) {
    // Avoid re-running full STT when a second detect pass confirms the same language after success.
    if (noteFullPreviewGateOk && prevSelect === nextSelect) return;
    const restart = !!transcribeFullPreviewInFlight && prevSelect !== nextSelect;
    void transcribeFullPreview({ restart }).then(() => syncVisibility());
  }
}

/** True after full-file `detectLanguageForNotePreview` finishes for the current blob (Generate + header pill). */
let noteLangDetectionComplete = false;

function syncLiveTxLangHeader() {
  if (!liveTxLangStatusEl) return;
  if (liveTranscriptWrapEl?.hidden) {
    liveTxLangStatusEl.hidden = true;
    return;
  }
  // Once the language row is shown (live detect, countdown expiry, or server result), the header
  // should not duplicate "Detecting language…" while full-file detect still runs for Generate gating.
  const langRowHidden = !noteLanguageWrapEl || noteLanguageWrapEl.hidden;
  const show =
    langRowHidden &&
    !noteLangDetectionComplete &&
    (note.isRecording || !!note.audioBlob) &&
    !noteFullPreviewGateOk;
  liveTxLangStatusEl.hidden = !show;
  if (show) liveTxLangStatusEl.textContent = 'Detecting language…';
}

/** User can run full preview once auto-detect finished, or sooner if they set a language hint (or overrode auto). */
function noteLanguageReadyForFullPreview() {
  if (noteLangDetectionComplete) return true;
  if (noteUserOverrodeLanguage) return true;
  const hint = (noteLanguageEl?.value ?? '').toString().trim();
  return !!hint;
}

function updateGenerateFullPreviewButtonVisibility() {
  // Generate-full-transcript control removed from UI; full preview is auto-started from language detect / selection.
  syncLiveTxLangHeader();
}

/** Before a new mic session: hide language row, clear hint, reset pill until detection runs. */
function resetNewNoteLanguageForRecording() {
  noteUserOverrodeLanguage = false;
  noteLastDetectedApiLang = '';
  if (noteLanguageWrapEl) noteLanguageWrapEl.hidden = true;
  if (noteLanguageEl) {
    noteLangProgrammatic = true;
    noteLanguageEl.value = '';
    noteLangProgrammatic = false;
  }
  if (noteDetectedLangEl) {
    noteDetectedLangEl.textContent = 'Auto-detect language';
    noteDetectedLangEl.hidden = true;
  }
}

/** When we have no duration or byte size yet, show a neutral countdown instead of elapsed time. */
const DEFAULT_PROCESSING_ESTIMATE_MS = 60_000;

/**
 * Floor for `duration * PROCESSING_TIME_ESTIMATE_RATIO` budgets. Short clips otherwise get a few
 * seconds of "linear" percent; local STT (ffmpeg + Python + first faster-whisper load) routinely
 * exceeds that, the percent hits the **1% floor** until the job finishes (no real engine progress signal).
 */
const MIN_DURATION_BASED_PROCESSING_ESTIMATE_MS = 18_000;

/** @returns {number|null} estimated processing duration in ms, or null if unknown */
function estimatedProcessingMsFromAudioDuration(durationMs) {
  const d = Number(durationMs) || 0;
  if (d <= 0) return null;
  return Math.max(1000, Math.round(d * PROCESSING_TIME_ESTIMATE_RATIO));
}

/** Infer playback duration from blob size at nominal recording bitrate (matches recorder setup). */
function audioDurationMsFromBytes(audioBytes) {
  const b = Number(audioBytes) || 0;
  if (b <= 0) return 0;
  return Math.max(0, Math.round((b * 8 * 1000) / AUDIO_BITS_PER_SECOND));
}

/** Best-effort audio length: stored duration, else size-based guess. */
function inferredAudioDurationMsForItem(item) {
  const d = Number(item?.duration_ms ?? 0) || 0;
  if (d > 0) return d;
  return audioDurationMsFromBytes(item?.audio_bytes);
}

/**
 * Wall-clock STT estimate (ms) used as the denominator for the processing **percent left** proxy.
 */
function totalProcessingEstimateMsForItem(item) {
  const audioLen = inferredAudioDurationMsForItem(item);
  if (audioLen > 0) {
    const est = estimatedProcessingMsFromAudioDuration(audioLen);
    if (est != null && est > 0) {
      return Math.max(MIN_DURATION_BASED_PROCESSING_ESTIMATE_MS, est);
    }
  }
  return DEFAULT_PROCESSING_ESTIMATE_MS;
}

/** Pending ingestion weight from server (100 ≈ transcribe, 12 ≈ backfill_words); inline retry has no rows → 100. */
function processingPendingUnitsForItem(item) {
  if ((item?.status ?? '').toString() !== 'processing') return 0;
  const u = Number(item?.processing_pending_units ?? NaN);
  if (Number.isFinite(u) && u > 0) return u;
  return 100;
}

function scaledProcessingBudgetFromBaseAndUnits(baseMs, units) {
  const u = Number.isFinite(Number(units)) && Number(units) > 0 ? Number(units) : 100;
  const frac = Math.min(1, u / 100);
  return Math.max(1000, Math.round(baseMs * Math.max(frac, 0.05)));
}

function scaledProcessingBudgetMsForItem(item) {
  return scaledProcessingBudgetFromBaseAndUnits(
    totalProcessingEstimateMsForItem(item),
    processingPendingUnitsForItem(item)
  );
}

let note = makeRecorderState();
let query = makeRecorderState();

let noteDraftDebounceTimer = null;
let noteDraftUploadSeq = 0;

function scheduleServerNoteDraftBackup() {
  if (!note?.audioBlob || note.audioBlob.size < 32) return;
  if (noteDraftDebounceTimer) clearTimeout(noteDraftDebounceTimer);
  noteDraftDebounceTimer = setTimeout(() => {
    noteDraftDebounceTimer = null;
    void flushServerNoteDraftBackup();
  }, 700);
}

async function flushServerNoteDraftBackup() {
  if (!note?.audioBlob || note.audioBlob.size < 32) return;
  noteDraftUploadSeq += 1;
  const seq = noteDraftUploadSeq;
  try {
    const fd = new FormData();
    fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));
    fd.append('duration_ms', String(Math.round(note.durationMs || 0)));
    const hasId = !!(note.serverDraftId ?? '').toString().trim();
    const url = hasId
      ? `/api/note-drafts/${encodeURIComponent(note.serverDraftId)}`
      : '/api/note-drafts';
    const method = hasId ? 'PUT' : 'POST';
    const resp = await fetch(url, { method, body: fd });
    if (seq !== noteDraftUploadSeq) return;
    if (!resp.ok) return;
    const data = await safeJson(resp);
    if (seq !== noteDraftUploadSeq) return;
    if (!hasId && data?.id) note.serverDraftId = String(data.id);
    try {
      if (note.serverDraftId) sessionStorage.setItem('vv_active_note_draft_id', note.serverDraftId);
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

async function abandonServerNoteDraft() {
  const id = (note.serverDraftId ?? '').toString().trim();
  note.serverDraftId = '';
  noteDraftUploadSeq += 1;
  if (noteDraftDebounceTimer) {
    clearTimeout(noteDraftDebounceTimer);
    noteDraftDebounceTimer = null;
  }
  try {
    sessionStorage.removeItem('vv_active_note_draft_id');
  } catch {
    // ignore
  }
  if (!id) return;
  try {
    await fetch(`/api/note-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
}

// Keep UI stable across polling refreshes
const expandedNoteIds = new Set();
/** Note ids opened automatically for search hit highlighting (`best_match`); cleared when search text is empty. */
const expandedNoteIdsFromSearchMatch = new Set();
let procStatusFilter = '';

let gridLayoutMode = 'auto'; // 'auto' | 'equal' | 'searchWide'

let libFavOnly = false;
let foldersCache = [];
let tagsCache = [];
let savedSearchesCache = [];

let playbackRate = loadNumberSetting('vv_playback_rate', 1);
let loopSegments = loadBoolSetting('vv_loop_segments', false);

let askMode = ((localStorage.getItem('vv_ask_mode') ?? 'auto').toString() || 'auto').toLowerCase();
if (!['auto', 'openai', 'ollama'].includes(askMode)) askMode = 'auto';

// Semantic is always-on (hybrid blended with keyword search).
let semanticMode = true;

// (Removed) Quick answer feature.
let lastSearchItems = [];
let lastSearchQuery = '';

/** Per-note processing timer: pause freezes percent left (`frozenPercentLeft`) and budget fields; resume sets `baseIso`. */
const procTimerByNoteId = new Map();

/**
 * Approximate **percent of transcription left** (100 = start of window, 1 = past-estimate floor).
 * Not from the STT engine; elapsed vs estimated budget only.
 *
 * Previously: (1) crossing `r = elapsed/budget > 1` used a "tail" curve starting at **~15%**, so the
 * UI jumped **up** right after reaching ~1%. (2) When `locked_at` appeared, elapsed switched from
 * full wall time to time-since-lock, which could **reset** progress and spike the percent again.
 */
function processingProgressFromAttrs({ baseMs, units, lockedAt, elapsedWallMs }) {
  void lockedAt; // kept for API symmetry / callers; do not reset elapsed when the job locks (avoids jumps)
  const scaledBudget = scaledProcessingBudgetFromBaseAndUnits(baseMs, units);
  const elapsedWork = Math.max(0, Number(elapsedWallMs) || 0);
  const b = scaledBudget > 0 ? scaledBudget : 1;
  const r = elapsedWork / b;
  if (r <= 1) {
    const left = 100 * (1 - r);
    return {
      pct: Math.max(1, Math.min(100, Math.round(left))),
      pastBudget: false,
      elapsedMs: elapsedWork,
      budgetMs: scaledBudget
    };
  }
  return { pct: 1, pastBudget: true, elapsedMs: elapsedWork, budgetMs: scaledBudget };
}

function processingPercentLeftFromAttrs(attrs) {
  return processingProgressFromAttrs(attrs).pct;
}

function processingProgressFromElement(el, elapsedWallSinceNoteStart) {
  const baseMs = Number(el.getAttribute('data-processing-base-ms') ?? '') || DEFAULT_PROCESSING_ESTIMATE_MS;
  const unitsRaw = Number(el.getAttribute('data-processing-pending-units') ?? '100');
  const units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : 100;
  const lockedAt = (el.getAttribute('data-processing-locked-at') ?? '').toString().trim();
  const coarseStage = (el.getAttribute('data-processing-stage') ?? '').toString().trim();
  const retranscribeFallback = (el.getAttribute('data-retranscribe-fallback') ?? '') === '1';
  const pr = processingProgressFromAttrs({ baseMs, units, lockedAt, elapsedWallMs: elapsedWallSinceNoteStart });
  return { ...pr, coarseStage, retranscribeFallback };
}

function processingPercentLeftFromElement(el, elapsedWallSinceNoteStart) {
  return processingProgressFromElement(el, elapsedWallSinceNoteStart).pct;
}

function formatProcessingPercentLeftLabel(pct) {
  const n = Math.round(Number(pct));
  if (!Number.isFinite(n) || n <= 0) return '…';
  return `${Math.max(1, Math.min(100, n))}% left`;
}

/** Human hint from server `processing_coarse_stage` (ingestion_jobs); refreshed with list poll. */
function coarseStageHint(stage) {
  const s = (stage ?? '').toString().trim().toLowerCase();
  // `queued` here almost always means “worker has not claimed the job yet”, not “other users ahead of you”.
  if (s === 'queued') return 'starting';
  if (s === 'running') return 'running';
  return '';
}

/** Past time budget: plain “Transcribing…”; with server stage, append hint in parentheses. */
function formatProcessingProgressChipText({ pct, pastBudget, coarseStage, retranscribeFallback = false, elapsedMs = 0, budgetMs = 0 }) {
  if (pastBudget) {
    const hint = coarseStageHint(coarseStage);
    const over = Math.max(0, (Number(elapsedMs) || 0) - (Number(budgetMs) || 0));
    const overSec = Math.floor(over / 1000);
    // Re-transcribe cards prefix the row with “ReTranscribing”; avoid repeating it in the chip.
    if (retranscribeFallback) {
      const tail = overSec > 0 ? `estimate +${overSec}s` : 'estimate';
      return hint ? `(${hint} • ${tail})` : tail;
    }
    const base = 'Transcribing…';
    const tail = overSec > 0 ? `estimate +${overSec}s` : 'estimate';
    return hint ? `${base} (${hint} • ${tail})` : `${base} (${tail})`;
  }
  return formatProcessingPercentLeftLabel(pct);
}

/** Note id saved from New note → Save while server transcribes; cleared when that note leaves `processing`. */
let newNotePendingProcessId = '';

/** Last successful `/api/transcribe` (full preview) for the current note audio; used on Save when still valid. */
let lastFullPreviewBundle = null;

/** True after a successful full-file preview for the current audio + language hint (Save stays gated until then). */
let noteFullPreviewGateOk = false;

/** After full preview fails or returns no usable segments, allow typing + Save via `final_transcript` without a bundle. */
let noteAllowManualSaveFinal = false;

/** Ignore `#noteLanguage` synthetic updates from auto-detect sync. */
let noteLangProgrammatic = false;

/** Current blob came from the mic (vs upload) — drives stage labels. */
let noteUsedMicForCurrentBlob = false;

/** Raw language string from last successful `/api/detect-language` (used when the dropdown has no matching option). */
let noteLastDetectedApiLang = '';

/** Once the user changes `#noteLanguage` manually, auto-detect must not overwrite their choice. */
let noteUserOverrodeLanguage = false;

/** In-flight full preview so Save can await the same run started after recording (avoids queued save when preview is still running). */
let transcribeFullPreviewInFlight = null;

/** Abort the current `/api/transcribe` when language changes or a new full preview is forced. */
let fullPreviewAbortController = null;

/** While any note in the current list is processing, poll so transcript appears when STT actually finishes (timer ≠ completion). */
let processingNotesPollId = null;

function syncProcessingNotesPoll(items) {
  const busy = Array.isArray(items) && items.some((it) => (it?.status ?? '').toString() === 'processing');
  if (!busy) {
    if (processingNotesPollId != null) {
      clearInterval(processingNotesPollId);
      processingNotesPollId = null;
    }
    return;
  }
  if (processingNotesPollId != null) return;
  processingNotesPollId = setInterval(() => {
    refreshResults((qEl?.value ?? '').toString()).catch(() => {
      // ignore
    });
  }, 2500);
}

function hideNewNoteProcessingStatus() {
  newNotePendingProcessId = '';
  if (newNoteProcessingRowEl) newNoteProcessingRowEl.hidden = true;
  if (newNoteProcessingTimeEl) {
    newNoteProcessingTimeEl.textContent = '—';
    newNoteProcessingTimeEl.removeAttribute('data-note-id');
    newNoteProcessingTimeEl.removeAttribute('data-processing-since');
    newNoteProcessingTimeEl.removeAttribute('data-estimated-total-ms');
    newNoteProcessingTimeEl.removeAttribute('data-processing-base-ms');
    newNoteProcessingTimeEl.removeAttribute('data-processing-pending-units');
    newNoteProcessingTimeEl.removeAttribute('data-processing-locked-at');
    newNoteProcessingTimeEl.removeAttribute('data-processing-stage');
    newNoteProcessingTimeEl.removeAttribute('data-retranscribe-fallback');
  }
  if (newNoteProcLabelEl) newNoteProcLabelEl.textContent = 'Processing';
}

/** Mirrors saved-note cards: same estimate helpers + `noteProcessingTime` class for `startProcessingTimers`. */
function clearLiveTxPreviewCountdown() {
  if (!liveTxTimeLeftEl) return;
  liveTxTimeLeftEl.textContent = '—';
  liveTxTimeLeftEl.removeAttribute('data-note-id');
  liveTxTimeLeftEl.removeAttribute('data-processing-since');
  liveTxTimeLeftEl.removeAttribute('data-estimated-total-ms');
  liveTxTimeLeftEl.removeAttribute('data-processing-base-ms');
  liveTxTimeLeftEl.removeAttribute('data-processing-pending-units');
  liveTxTimeLeftEl.removeAttribute('data-processing-locked-at');
  liveTxTimeLeftEl.removeAttribute('data-processing-stage');
}

/** Full-preview + live-chunk transcribe: same ETA pattern as saved-note cards (via `startProcessingTimers`). */
function armLiveTxPreviewCountdown(pseudoItem) {
  if (!liveTxTimeLeftEl) return;
  clearLiveTxPreviewCountdown();
  const est = totalProcessingEstimateMsForItem(pseudoItem);
  const processingSinceIso = new Date().toISOString();
  liveTxTimeLeftEl.setAttribute('data-note-id', '__vv_live_preview');
  liveTxTimeLeftEl.setAttribute('data-processing-since', processingSinceIso);
  liveTxTimeLeftEl.setAttribute('data-estimated-total-ms', String(est));
  liveTxTimeLeftEl.setAttribute('data-processing-base-ms', String(est));
  liveTxTimeLeftEl.setAttribute('data-processing-pending-units', '100');
  liveTxTimeLeftEl.setAttribute('data-processing-locked-at', '');
  liveTxTimeLeftEl.setAttribute('data-processing-stage', '');
  liveTxTimeLeftEl.textContent = formatProcessingProgressChipText(
    processingProgressFromElement(liveTxTimeLeftEl, 0)
  );
}

function showNewNoteProcessingStatus(noteId, { durationMs = 0, audioBytes = 0, retranscribe = false } = {}) {
  if (!newNoteProcessingTimeEl || !newNoteProcessingRowEl) return;
  const id = (noteId ?? '').toString().trim();
  if (!id) return;
  newNotePendingProcessId = id;
  if (newNoteProcLabelEl) newNoteProcLabelEl.textContent = retranscribe ? 'Re-transcribing to save' : 'Processing';
  const pseudoItem = {
    duration_ms: durationMs,
    audio_bytes: audioBytes
  };
  const estProcMs = totalProcessingEstimateMsForItem(pseudoItem);
  const processingSinceIso = new Date().toISOString();

  newNoteProcessingTimeEl.setAttribute('data-note-id', id);
  newNoteProcessingTimeEl.setAttribute('data-processing-since', processingSinceIso);
  newNoteProcessingTimeEl.setAttribute('data-estimated-total-ms', String(estProcMs));
  newNoteProcessingTimeEl.setAttribute('data-processing-base-ms', String(estProcMs));
  newNoteProcessingTimeEl.setAttribute('data-processing-pending-units', '100');
  newNoteProcessingTimeEl.setAttribute('data-processing-locked-at', '');
  newNoteProcessingTimeEl.setAttribute('data-processing-stage', '');
  newNoteProcessingTimeEl.setAttribute('data-retranscribe-fallback', retranscribe ? '1' : '0');
  newNoteProcessingTimeEl.textContent = formatProcessingProgressChipText(
    processingProgressFromElement(newNoteProcessingTimeEl, 0)
  );
  newNoteProcessingRowEl.hidden = false;
}

function syncProcTimerFromServerPaused(noteId, processingSinceIso, procPaused, status, item) {
  const id = (noteId ?? '').toString();
  if ((status ?? '').toString() !== 'processing' || !procPaused || procTimerByNoteId.has(id)) return;
  const base = Date.parse((processingSinceIso ?? '').toString()) || Date.now();
  const elapsed = Math.max(0, Date.now() - base);
  const est = scaledProcessingBudgetMsForItem(item);
  const baseProcMs = totalProcessingEstimateMsForItem(item);
  const units = processingPendingUnitsForItem(item);
  const locked = (item.processing_running_locked_at ?? '').toString().trim();
  const stage = (item.processing_coarse_stage ?? '').toString().trim();
  const frozenProg = processingProgressFromAttrs({
    baseMs: baseProcMs,
    units,
    lockedAt: locked,
    elapsedWallMs: elapsed
  });
  const rtf = (item.transcribe_mode ?? '').toString().trim() === 'retranscribe';
  const frozenChipText = formatProcessingProgressChipText({
    ...frozenProg,
    coarseStage: stage,
    retranscribeFallback: rtf
  });
  procTimerByNoteId.set(id, {
    paused: true,
    frozenRemainingMs: Math.max(0, est - elapsed),
    estimatedMs: est,
    frozenPercentLeft: frozenProg.pct,
    frozenPastBudget: frozenProg.pastBudget,
    frozenCoarseStage: stage,
    frozenChipText
  });
}

function timerAttrIsoForNote(noteId, processingSinceIso) {
  const id = (noteId ?? '').toString();
  const tm = procTimerByNoteId.get(id);
  if (tm?.baseIso && !tm.paused) return tm.baseIso;
  return (processingSinceIso ?? '').toString();
}

let advancedSearchOpen = ((localStorage.getItem('vv_adv_search_open') ?? '0').toString().trim() === '1');

function ensureElementFullyVisible(el, pad = 8) {
  if (!el) return;
  try {
    const r = el.getBoundingClientRect();
    const overflowBottom = r.bottom - (window.innerHeight - pad);
    const overflowTop = pad - r.top;
    if (overflowBottom > 0) window.scrollBy({ top: overflowBottom, left: 0, behavior: 'smooth' });
    else if (overflowTop > 0) window.scrollBy({ top: -overflowTop, left: 0, behavior: 'smooth' });
  } catch {
    // ignore
  }
}

/** Same values as #noteLanguage in index.html (keep in sync when adding languages). */
const NOTE_LANGUAGE_OPTIONS = [
  { value: '', label: 'Auto-detect' },
  { value: 'en', label: 'English (en)' },
  { value: 'hi', label: 'Hindi (hi)' },
  { value: 'es', label: 'Spanish (es)' },
  { value: 'fr', label: 'French (fr)' },
  { value: 'de', label: 'German (de)' },
  { value: 'it', label: 'Italian (it)' },
  { value: 'pt', label: 'Portuguese (pt)' },
  { value: 'ja', label: 'Japanese (ja)' },
  { value: 'ko', label: 'Korean (ko)' },
  { value: 'zh', label: 'Chinese (zh)' }
];

/** Human-readable language for note toolbar (raw codes like `hi` read like English "hi"). */
function formatNoteLanguageMeta(langRaw) {
  const raw = (langRaw ?? '').toString().trim();
  if (!raw) return '';
  const norm = raw.replaceAll('_', '-').trim();
  const primary = (norm.split('-')[0] ?? '').toLowerCase();
  const opt = NOTE_LANGUAGE_OPTIONS.find((o) => o.value && o.value.toLowerCase() === primary);
  if (opt?.label) {
    return opt.label.replace(/\s*\([^)]+\)\s*$/, '').trim() || opt.label;
  }
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    try {
      const full = dn.of(norm);
      if (full && full.toLowerCase() !== norm.toLowerCase()) return full;
    } catch {
      // ignore
    }
    if (primary.length >= 2 && primary.length <= 3) {
      const pLabel = dn.of(primary);
      if (pLabel && pLabel.toLowerCase() !== primary) return pLabel;
    }
  } catch {
    // ignore
  }
  return raw;
}

/**
 * @param {{ currentLang: string }} opts
 * @param {(payload: { lang: string }) => void | Promise<void>} onApply
 */
function openChangeLanguageDialog(opts, onApply) {
  const currentLang = (opts?.currentLang ?? '').toString();

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'vvChangeLangTitle');

  const optsHtml = NOTE_LANGUAGE_OPTIONS.map(
    (o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
  ).join('');

  overlay.innerHTML = `
    <div class="dialog" style="width:min(440px,96vw)">
      <div id="vvChangeLangTitle" style="font-weight:850; margin-bottom:12px">Change language</div>
      <p style="margin:0 0 12px; font-size:13px; color:rgba(0,0,0,0.72); line-height:1.45">
        Updates the transcription hint for this note and re-runs transcription on the saved audio (same as Reprocess).
      </p>
      <label class="label" style="margin-bottom:0">
        Language
        <select class="input vvChangeLangSelect" style="margin-top:6px; background:rgba(255,255,255,0.95); color:rgba(0,0,0,0.92); border-color:rgba(255,255,255,0.75)">
          ${optsHtml}
        </select>
      </label>
      <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap">
        <button type="button" class="btn vvIconBtn vvChangeLangCancel" aria-label="Cancel" title="Cancel">${VV_ICON_SVG.cancel}</button>
        <button type="button" class="btn primary vvChangeLangApply">Apply &amp; re-transcribe</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const sel = overlay.querySelector('.vvChangeLangSelect');
  if (sel instanceof HTMLSelectElement) {
    const cur = currentLang.trim();
    sel.value = NOTE_LANGUAGE_OPTIONS.some((o) => o.value === cur) ? cur : '';
  }

  const close = () => {
    try {
      overlay.remove();
    } catch {
      // ignore
    }
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const onKey = (e) => {
    if ((e?.key ?? '') === 'Escape') {
      e.preventDefault();
      close();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);

  overlay.querySelector('.vvChangeLangCancel')?.addEventListener('click', () => {
    document.removeEventListener('keydown', onKey, true);
    close();
  });

  overlay.querySelector('.vvChangeLangApply')?.addEventListener('click', async () => {
    const lang = sel instanceof HTMLSelectElement ? sel.value : '';
    document.removeEventListener('keydown', onKey, true);
    try {
      await onApply({ lang });
    } finally {
      close();
    }
  });

  try {
    overlay.querySelector('.vvChangeLangSelect')?.focus?.();
  } catch {
    // ignore
  }
}

function closeAllActionMenus(exceptEl = null) {
  try {
    const openMenus = Array.from(document.querySelectorAll('.noteActions:not([hidden])'));
    for (const m of openMenus) {
      if (exceptEl && m === exceptEl) continue;
      m.hidden = true;
    }
    const toggles = Array.from(document.querySelectorAll('button[data-actions-toggle]'));
    for (const t of toggles) t.textContent = '▼';

    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches?.('button[data-actions-toggle]')) {
      active.blur();
    }
  } catch {
    // ignore
  }
}

function installActionMenuGlobalHandlersOnce() {
  if (window.__vvActionMenuHandlersInstalled) return;
  window.__vvActionMenuHandlersInstalled = true;

  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('.noteActionsWrap') || t.closest('.noteActions')) return;
      closeAllActionMenus();
    },
    true
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if ((e?.key ?? '') === 'Escape') closeAllActionMenus();
    },
    true
  );

  window.addEventListener('resize', () => closeAllActionMenus(), true);
}

function applyMainGridColumns(mode) {
  if (!mainGridEl) return;
  try {
    if (window.innerWidth < 820) {
      mainGridEl.style.removeProperty('grid-template-columns');
      return;
    }
    if (mode === 'dock') {
      mainGridEl.style.setProperty('grid-template-columns', '1fr', 'important');
      return;
    }
    const cols = mode === 'equal' ? '1fr 1fr' : mode === 'searchWide' ? '0.35fr 1.65fr' : '';
    if (!cols) {
      mainGridEl.style.removeProperty('grid-template-columns');
      return;
    }
    mainGridEl.style.setProperty('grid-template-columns', cols, 'important');
  } catch {
    // ignore
  }
}

function syncFloatDockVisibility() {
  if (!floatDockEl) return;
  const showSearchBtn = !!(btnFloatSearchEl && !btnFloatSearchEl.hidden);
  const showProcBtn = !!(btnFloatProcessesEl && !btnFloatProcessesEl.hidden);
  const showNewNoteBtn = !!(btnFloatNewNoteEl && !btnFloatNewNoteEl.hidden);
  const showHelpBtn = !!(btnFloatHelpEl && !btnFloatHelpEl.hidden);
  floatDockEl.hidden = !showSearchBtn && !showProcBtn && !showNewNoteBtn && !showHelpBtn;
}

function expandAppHintInHelp() {
  const aboutBox = document.getElementById('aboutBox');
  const aboutToggle = document.getElementById('aboutToggle');
  const uiStepsBox = document.getElementById('uiStepsBox');
  const uiStepsToggle = document.getElementById('uiStepsToggle');
  if (aboutBox) aboutBox.hidden = false;
  if (aboutToggle) aboutToggle.textContent = 'Hide App hint';
  if (uiStepsBox) uiStepsBox.hidden = true;
  if (uiStepsToggle) uiStepsToggle.textContent = 'UI steps';
}

/** Scroll so the bottom of the document sits in view (quick-action bar, footer padding). Retries after layout for tall panels (Help, etc.). */
function scrollPageBottomIntoView({ behavior = 'smooth', bottomPad = 24 } = {}) {
  try {
    const se = document.scrollingElement || document.documentElement;
    const viewH = window.visualViewport?.height ?? se.clientHeight ?? window.innerHeight;
    const maxScroll = Math.max(0, se.scrollHeight - viewH);
    const top = Math.max(0, maxScroll - bottomPad);
    window.scrollTo({ top, left: 0, behavior });
  } catch {
    try {
      const se = document.scrollingElement || document.documentElement;
      se.scrollTop = Math.max(0, se.scrollHeight - se.clientHeight);
    } catch {
      // ignore
    }
  }
}

function scheduleScrollPageBottomAfterExpand() {
  const run = () => scrollPageBottomIntoView({ behavior: 'smooth', bottomPad: 28 });
  try {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        run();
        window.setTimeout(run, 0);
        window.setTimeout(run, 120);
        window.setTimeout(run, 320);
      });
    });
  } catch {
    scrollPageBottomIntoView({ behavior: 'auto', bottomPad: 28 });
  }
}

/** Search results: last note uses page-bottom scroll; others only scroll enough to fit the note row. */
function scheduleExpandedNoteScroll(noteEl, isLastNote) {
  if (!noteEl) return;
  if (isLastNote) {
    scheduleScrollPageBottomAfterExpand();
    return;
  }
  const run = () => {
    try {
      ensureElementFullyVisible(noteEl, 20);
    } catch {
      // ignore
    }
  };
  try {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        run();
        window.setTimeout(run, 0);
        window.setTimeout(run, 120);
        window.setTimeout(run, 320);
      });
    });
  } catch {
    run();
  }
}

function updateMainGridLayout({ prefer = 'auto' } = {}) {
  if (!mainGridEl) return;
  if (prefer !== 'auto') gridLayoutMode = prefer;

  mainGridEl.classList.add('mainGrid--dock');
  syncFloatDockVisibility();
  applyMainGridColumns('dock');

  if (statusEl) {
    statusEl.title = `layout: dock, mode=${gridLayoutMode}`;
  }
}

/** Only one of Search / Processes / New note / Help may be expanded at a time. */
function closeAllPanelsExcept(except) {
  if (except !== 'search') setSearchPanelOpen(false);
  if (except !== 'newNote') setNewNotePanelOpen(false);
  if (except !== 'help') setHelpPanelOpen(false);
  if (except !== 'processes') setProcessesPanelOpen(false);
}

function expandProcessesSide() {
  setProcessesPanelOpen(true);
}

function setProcessesPanelOpen(open) {
  if (!processCardEl) return;
  const on = !!open;
  if (on) closeAllPanelsExcept('processes');
  processCardEl.hidden = !on;
  if (btnFloatProcessesEl) {
    btnFloatProcessesEl.hidden = on;
    btnFloatProcessesEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (on && procBodyEl) procBodyEl.hidden = false;
  updateMainGridLayout({ prefer: 'auto' });
  if (on) {
    void refreshIngestionUi({ toggleList: false, forceShow: true }).finally(() => {
      scheduleScrollPageBottomAfterExpand();
    });
  }
}

function setNewNotePanelOpen(open) {
  if (!newNoteCardEl) return;
  const on = !!open;
  if (on) closeAllPanelsExcept('newNote');
  newNoteCardEl.hidden = !on;
  if (on && newNoteBodyEl) newNoteBodyEl.hidden = false;
  // If user re-opens New note without an active blob/recording, reset language UI so stale
  // auto-detect pills don't persist across reloads/panel toggles.
  try {
    if (on && !note?.isRecording && !note?.audioBlob) {
      resetNewNoteLanguageForRecording();
      stopNoteLangDetectCountdown();
      noteLangDetectionComplete = false;
      syncLiveTxLangHeader();
      updateGenerateFullPreviewButtonVisibility();
      syncVisibility();
    }
  } catch {
    // ignore
  }
  if (btnFloatNewNoteEl) {
    btnFloatNewNoteEl.hidden = on;
    btnFloatNewNoteEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateMainGridLayout({ prefer: 'auto' });
  if (on) scheduleScrollPageBottomAfterExpand();
}

function setHelpPanelOpen(open) {
  if (!helpCardEl) return;
  const on = !!open;
  if (on) closeAllPanelsExcept('help');
  helpCardEl.hidden = !on;
  if (on) expandAppHintInHelp();
  else {
    const aboutBox = document.getElementById('aboutBox');
    const uiStepsBox = document.getElementById('uiStepsBox');
    const aboutToggle = document.getElementById('aboutToggle');
    const uiStepsToggle = document.getElementById('uiStepsToggle');
    if (aboutBox) aboutBox.hidden = true;
    if (uiStepsBox) uiStepsBox.hidden = true;
    if (aboutToggle) aboutToggle.textContent = 'App hint';
    if (uiStepsToggle) uiStepsToggle.textContent = 'UI steps';
  }
  if (btnFloatHelpEl) {
    btnFloatHelpEl.hidden = on;
    btnFloatHelpEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateMainGridLayout({ prefer: 'auto' });
  if (on) scheduleScrollPageBottomAfterExpand();
}

function setSearchPanelOpen(open, { focusQuery = false } = {}) {
  if (!searchCardEl) return;
  const on = !!open;
  if (on) closeAllPanelsExcept('search');
  searchCardEl.hidden = !on;
  if (on && searchBodyEl) searchBodyEl.hidden = false;
  if (btnFloatSearchEl) {
    btnFloatSearchEl.hidden = on;
    btnFloatSearchEl.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateMainGridLayout({ prefer: 'auto' });
  if (on) {
    scheduleScrollPageBottomAfterExpand();
    if (focusQuery) {
      try {
        requestAnimationFrame(() => qEl?.focus?.());
      } catch {
        // ignore
      }
    }
  }
}

function resetSearchAndReturnToDefault({ closePanel = true } = {}) {
  try {
    if (query.isRecording) return;
  } catch {
    // ignore
  }

  try {
    if (qEl) qEl.value = '';
  } catch {
    // ignore
  }

  try {
    resetRecorder(query);
  } catch {
    // ignore
  }

  try {
    if (previewQuery) {
      previewQuery.hidden = true;
      previewQuery.src = '';
    }
  } catch {
    // ignore
  }

  try {
    btnSearch.hidden = true;
    btnSearch.disabled = true;
  } catch {
    // ignore
  }

  if (closePanel) setSearchPanelOpen(false);

  refreshResults('').catch(() => {
    // ignore
  });

  syncVisibility();
}

function setAdvancedSearchOpen(open) {
  advancedSearchOpen = !!open;
  if (advancedSearchBodyEl) advancedSearchBodyEl.hidden = !advancedSearchOpen;
  if (btnAdvancedSearchToggleEl) btnAdvancedSearchToggleEl.textContent = advancedSearchOpen ? 'Hide' : 'Show';
  // Ensure Ask mode dropdown visibility follows panel state + semantic mode.
  try {
    if (askModeEl) {
      const show = advancedSearchOpen && isSemanticMode();
      askModeEl.hidden = !show;
      askModeEl.disabled = !show || (qEl?.value ?? '').toString().trim().length === 0;
    }
  } catch {
    // ignore
  }
  try {
    localStorage.setItem('vv_adv_search_open', advancedSearchOpen ? '1' : '0');
  } catch {
    // ignore
  }
}

bootstrapAutoTitle();
noteTimerEl?.setAttribute('hidden', '');
queryTimerEl?.setAttribute('hidden', '');
noteDetectedLangEl?.setAttribute('hidden', '');
stopTimer(note, noteTimerEl);
stopTimer(query, queryTimerEl);
renderBitrateHint();
try {
  localStorage.removeItem('vv_note_stt_engine');
} catch {
  // ignore
}

await refreshServerPreferredSttProvider();
wire();
setSemanticMode(semanticMode);
await refreshResults();
refreshIngestionUi().catch(() => {
  // ignore
});
syncVisibility();
startProcessingTimers();

function beaconStopAllProcessing() {
  try {
    const url = `${window.location.origin}/api/processing/stop-all`;
    const blob = new Blob(['{}'], { type: 'application/json' });
    if (navigator.sendBeacon) navigator.sendBeacon(url, blob);
    else fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true });
  } catch {
    // ignore
  }
}
window.addEventListener('pagehide', beaconStopAllProcessing);
window.addEventListener('beforeunload', beaconStopAllProcessing);

function wire() {
  // Ensure New note language UI is clean on refresh/reload.
  stopNoteLangDetectCountdown();
  noteLangDetectionComplete = false;
  if (note) note.liveDetectedLang = '';
  resetNewNoteLanguageForRecording();

  // Saved searches + folder/tag filtering removed.

  btnChooseImportZipEl?.addEventListener('click', (e) => {
    e.preventDefault();
    importZipEl?.click?.();
  });
  importZipEl?.addEventListener('change', () => {
    const f = importZipEl?.files?.[0];
    if (importZipNameEl) importZipNameEl.textContent = f ? f.name : 'No file';
  });
  btnImportZipEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    const f = importZipEl?.files?.[0];
    if (!f) return setStatus('Choose a .zip to import', true);
    if (!confirm('Import backup now? This will REPLACE your local DB and blobs. A backup copy will be kept in data/.')) return;
    btnImportZipEl.disabled = true;
    try {
      const fd = new FormData();
      fd.append('backup', f, f.name);
      const r = await fetch('/api/import', { method: 'POST', body: fd });
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j?.error || `Import failed (${r.status})`);
      setStatus('Import complete. Reloading…');
      // Clear segment-loaded markers by reloading page.
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      setStatus(`Import error: ${err?.message ?? err}`, true);
    } finally {
      btnImportZipEl.disabled = false;
    }
  });

  btnNewNoteToggleEl?.addEventListener('click', (e) => {
    e.preventDefault();
    setNewNotePanelOpen(false);
  });

  btnHelpCloseEl?.addEventListener('click', (e) => {
    e.preventDefault();
    setHelpPanelOpen(false);
  });

  btnSearchCloseEl?.addEventListener('click', (e) => {
    e.preventDefault();
    resetSearchAndReturnToDefault({ closePanel: true });
  });

  btnFloatSearchEl?.addEventListener('click', (e) => {
    e.preventDefault();
    setSearchPanelOpen(true, { focusQuery: true });
  });

  btnFloatNewNoteEl?.addEventListener('click', (e) => {
    e.preventDefault();
    const willOpen = !!newNoteCardEl?.hidden;
    setNewNotePanelOpen(willOpen);
  });

  btnFloatHelpEl?.addEventListener('click', (e) => {
    e.preventDefault();
    const willOpen = !!helpCardEl?.hidden;
    setHelpPanelOpen(willOpen);
  });

  btnRecordNote.addEventListener('click', () =>
    startRecording(note, {
      onUi: (s) => {
        btnRecordNote.hidden = s.isRecording;
        btnRecordNote.disabled = s.isRecording;
        btnStopNote.hidden = !s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
        if (liveTranscriptEl) {
          liveTranscriptEl.disabled = false;
          liveTranscriptEl.readOnly =
            s.isRecording || (!noteFullPreviewGateOk && !noteAllowManualSaveFinal);
        }
        syncVisibility();
      },
      label: 'note'
    })
  );

  btnStopNote.addEventListener('click', () =>
    stopRecording(note, {
      onUi: (s) => {
        btnRecordNote.hidden = s.isRecording;
        btnRecordNote.disabled = s.isRecording;
        btnStopNote.hidden = !s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
        if (liveTranscriptEl) {
          liveTranscriptEl.disabled = false;
          liveTranscriptEl.readOnly = !noteFullPreviewGateOk && !noteAllowManualSaveFinal;
        }
        syncVisibility();
      }
    })
  );
  btnSaveNote.addEventListener('click', saveNote);

  liveTxUpEl?.addEventListener('click', (e) => {
    e.preventDefault();
    liveTranscriptEl?.scrollBy({ top: -220, behavior: 'smooth' });
  });
  liveTxDownEl?.addEventListener('click', (e) => {
    e.preventDefault();
    liveTranscriptEl?.scrollBy({ top: 220, behavior: 'smooth' });
  });

  liveTranscriptEl?.addEventListener('input', () => {
    syncLiveTxScrollRowVisibility();
    syncVisibility();
  });

  noteLanguageEl?.addEventListener('change', async () => {
    if (noteLangProgrammatic) return;
    noteUserOverrodeLanguage = true;
    lastFullPreviewBundle = null;
    noteFullPreviewGateOk = false;
    noteAllowManualSaveFinal = false;
    const v = (noteLanguageEl.value ?? '').toString().trim();
    try {
      localStorage.setItem('vv_last_note_language', v);
    } catch {
      // ignore
    }
    if (noteDetectedLangEl && note.audioBlob) {
      noteDetectedLangEl.hidden = false;
      const label = v ? formatNoteLanguageMeta(v) || v : '—';
      noteDetectedLangEl.textContent = v ? `Lang: ${label}` : 'Lang: —';
    }
    if (liveTranscriptEl && note.audioBlob) {
      liveTranscriptEl.readOnly = true;
    }
    updateGenerateFullPreviewButtonVisibility();
    syncVisibility();

    // Auto-start/restart full preview when a language is selected.
    if (v && note.audioBlob && !note.isRecording) {
      await transcribeFullPreview({ restart: true });
      syncVisibility();
    }
  });

  uploadNoteBtnEl?.addEventListener('click', (e) => {
    e.preventDefault();
    uploadNoteEl?.click();
  });

  uploadNoteEl?.addEventListener('change', async () => {
    const f = uploadNoteEl.files?.[0];
    if (uploadNoteNameEl) {
      uploadNoteNameEl.textContent = f ? f.name : 'No file selected';
    }
    if (!f) return;

    // Stop any recording and replace the pending note with the uploaded file.
    try {
      if (note.isRecording) stopRecording(note);
    } catch {
      // ignore
    }

    resetRecorder(note);
    resetNewNoteLanguageForRecording();
    stopNoteLangDetectCountdown();
    noteLangDetectionComplete = false;
    note.liveDetectedLang = '';
    // Switching modes (record → upload) should reset language back to Auto-detect.
    noteUsedMicForCurrentBlob = false;
    note.audioBlob = f;
    note.sourceFilename = f.name;
    note.previewUrl = URL.createObjectURL(f);
    previewNote.hidden = false;
    previewNote.src = note.previewUrl;

    // Best-effort duration read from metadata.
    try {
      const tmpAudio = new Audio();
      tmpAudio.src = note.previewUrl;
      await new Promise((resolve, reject) => {
        tmpAudio.addEventListener('loadedmetadata', resolve, { once: true });
        tmpAudio.addEventListener('error', reject, { once: true });
      });
      if (Number.isFinite(tmpAudio.duration) && tmpAudio.duration > 0) {
        note.durationMs = Math.round(tmpAudio.duration * 1000);
      }
    } catch {
      // ignore; duration stays 0
    }

    titleEl.value = defaultUploadTitle();

    notePostRecordPipelinePromise = runNotePostRecordTranscriptionPipeline('upload').finally(() => {
      notePostRecordPipelinePromise = null;
    });

    syncVisibility();
    setStatus('Loaded audio file');
    scheduleServerNoteDraftBackup();

    if (liveTranscriptEl) {
      liveTranscriptEl.disabled = false;
      liveTranscriptEl.readOnly = true;
    }
  });

  btnRecordQuery.addEventListener('click', () =>
    startRecording(query, {
      onUi: (s) => {
        btnRecordQuery.hidden = s.isRecording;
        btnStopQuery.hidden = !s.isRecording;
        btnStopQuery.disabled = !s.isRecording;
        btnSearch.hidden = (!s.hasAudio && qEl.value.trim().length === 0) || s.isRecording;
        btnSearch.disabled = (!s.hasAudio && qEl.value.trim().length === 0) || s.isRecording;
        previewQuery.hidden = !s.previewUrl;
        if (s.previewUrl) previewQuery.src = s.previewUrl;
        // Revert: prevent manual edits while recording; we will update via live transcription.
        qEl.disabled = s.isRecording;
      },
      label: 'search'
    })
  );
  btnStopQuery.addEventListener('click', () =>
    stopRecording(query, {
      onUi: (s) => {
        btnRecordQuery.hidden = s.isRecording;
        btnStopQuery.hidden = !s.isRecording;
        btnStopQuery.disabled = !s.isRecording;
        btnSearch.hidden = (qEl.value.trim().length === 0 && !s.hasAudio) || s.isRecording;
        btnSearch.disabled = (qEl.value.trim().length === 0 && !s.hasAudio) || s.isRecording;
        previewQuery.hidden = !s.previewUrl;
        if (s.previewUrl) previewQuery.src = s.previewUrl;
        qEl.disabled = s.isRecording;
      }
    })
  );
  btnSearch.addEventListener('click', runAudioSearch);
  btnSemanticToggleEl?.addEventListener('click', (e) => {
    e.preventDefault();
    setSemanticMode(!isSemanticMode());
    syncVisibility();
    refreshResults(qEl.value).catch(() => {
      // ignore
    });
  });

  qEl.addEventListener('input', () => {
    // While recording, ignore manual changes (input should be disabled anyway).
    if (query.isRecording) return;

    const shouldHide = qEl.value.trim().length === 0 && !query.audioBlob;
    btnSearch.hidden = shouldHide;
    btnSearch.disabled = shouldHide;

    // If user clears search, reset fully and return to default Saved Notes view.
    if (qEl.value.trim().length === 0) resetSearchAndReturnToDefault({ closePanel: true });

    // Keep Quick answer enabled/disabled in sync with typed text.
    syncVisibility();
  });

  qEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (query.isRecording) return;
    // Press Enter to search (same as clicking Search).
    const hasText = qEl.value.trim().length > 0;
    const hasAudio = !!query.audioBlob;
    if (!hasText && !hasAudio) return;
    e.preventDefault();
    runAudioSearch().catch(() => {
      // ignore
    });
  });

  btnIngestPauseEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    btnIngestPauseEl.disabled = true;
    try {
      await fetch('/api/ingestion/pause', { method: 'POST' });
      setStatus('Processing paused');
      await refreshIngestionUi({ toggleList: false, forceShow: true });
    } catch {
      // ignore
    } finally {
      btnIngestPauseEl.disabled = false;
    }
  });

  btnIngestResumeEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    btnIngestResumeEl.disabled = true;
    try {
      await fetch('/api/ingestion/resume', { method: 'POST' });
      setStatus('Processing resumed');
      await refreshIngestionUi({ toggleList: false, forceShow: true });
    } catch {
      // ignore
    } finally {
      btnIngestResumeEl.disabled = false;
    }
  });

  btnProcessesCloseEl?.addEventListener('click', (e) => {
    e.preventDefault();
    setProcessesPanelOpen(false);
  });

  btnFloatProcessesEl?.addEventListener('click', (e) => {
    e.preventDefault();
    setProcessesPanelOpen(true);
  });

  btnJobsApplyEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    await applyProcessingSettings();
  });

  btnJobsRetryAllEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Retry all failed jobs? This will re-queue all jobs currently in error state.')) return;
    btnJobsRetryAllEl.disabled = true;
    try {
      const r = await fetch('/api/processes/retry-all-errors', { method: 'POST' });
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j?.error || `Retry-all failed (${r.status})`);
      setStatus(`Re-queued ${Number(j?.retried ?? 0) || 0} jobs`);
      await refreshIngestionUi({ toggleList: false, forceShow: true });
    } catch (err) {
      setStatus(`Retry-all error: ${err?.message ?? err}`, true);
    } finally {
      btnJobsRetryAllEl.disabled = false;
    }
  });

  btnJobsUnlockNowEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('Unlock stale running jobs now? This will only unlock jobs older than the lock timeout.')) return;
    btnJobsUnlockNowEl.disabled = true;
    try {
      const r = await fetch('/api/processes/unlock-stale', { method: 'POST' });
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j?.error || `Unlock failed (${r.status})`);
      setStatus(`Unlocked ${Number(j?.unlocked ?? 0) || 0} jobs`);
      await refreshIngestionUi({ toggleList: false, forceShow: true });
    } catch (err) {
      setStatus(`Unlock error: ${err?.message ?? err}`, true);
    } finally {
      btnJobsUnlockNowEl.disabled = false;
    }
  });

  // Default: Search + Processes collapsed; New note + Help closed; Help hint panels collapsed.
  try {
    setSearchPanelOpen(false);
    setProcessesPanelOpen(false);
    setNewNotePanelOpen(false);
    setHelpPanelOpen(false);
    const aboutBoxEl = document.getElementById('aboutBox');
    const uiStepsBoxEl = document.getElementById('uiStepsBox');
    const aboutToggleEl = document.getElementById('aboutToggle');
    const uiStepsToggleEl = document.getElementById('uiStepsToggle');
    if (aboutBoxEl) aboutBoxEl.hidden = true;
    if (uiStepsBoxEl) uiStepsBoxEl.hidden = true;
    if (aboutToggleEl) aboutToggleEl.textContent = 'App hint';
    if (uiStepsToggleEl) uiStepsToggleEl.textContent = 'UI steps';
    updateMainGridLayout({ prefer: 'auto' });
  } catch {
    // ignore
  }
  try {
    window.addEventListener('keydown', onGlobalKeyDown);
  } catch {
    // ignore
  }
  try {
    window.addEventListener('resize', () => updateMainGridLayout({ prefer: 'auto' }));
  } catch {
    // ignore
  }
}

function onGlobalKeyDown(e) {
  const tag = (e.target?.tagName ?? '').toString().toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
  if (typing && e.key !== '/') return;

  if (e.key === '/') {
    e.preventDefault();
    if (searchCardEl?.hidden) setSearchPanelOpen(true, { focusQuery: true });
    else qEl?.focus?.();
    return;
  }

  if (e.code === 'Space') {
    e.preventDefault();
    const audio = document.querySelector('.noteDetails:not([hidden]) audio.audio:not([hidden])');
    if (!audio) return;
    try {
      if (!audio.paused) audio.pause();
      else audio.play();
    } catch {
      // ignore
    }
    return;
  }

  if (e.key === 'j' || e.key === 'k' || e.key === 'J' || e.key === 'K') {
    const dir = e.key.toLowerCase() === 'j' ? -1 : 1;
    const container = document.querySelector('.noteDetails:not([hidden])');
    if (!container) return;
    const plays = Array.from(container.querySelectorAll('button.segPlay[data-seg-start][data-seg-end]'));
    if (plays.length === 0) return;
    e.preventDefault();
    const audio = container.querySelector('audio.audio');
    const curStart = audio?.__vvLastSegStart;
    const curEnd = audio?.__vvLastSegEnd;
    let idx = -1;
    if (Number.isFinite(curStart) && Number.isFinite(curEnd)) {
      idx = plays.findIndex(
        (b) =>
          Number(b.getAttribute('data-seg-start')) === curStart && Number(b.getAttribute('data-seg-end')) === curEnd
      );
    }
    if (idx < 0) idx = 0;
    const next = Math.max(0, Math.min(plays.length - 1, idx + dir));
    plays[next]?.click?.();
  }
}

function closeMetaManage() {
  if (metaManageOverlayEl) metaManageOverlayEl.hidden = true;
}

async function openMetaManage() {
  if (!metaManageOverlayEl) return;
  metaManageOverlayEl.hidden = false;
  await refreshLibraryMeta();
}

async function refreshLibraryMeta() {
  try {
    const [fr, tr] = await Promise.all([fetch('/api/folders'), fetch('/api/tags')]);
    const fj = await safeJson(fr);
    const tj = await safeJson(tr);
    foldersCache = Array.isArray(fj?.items) ? fj.items : [];
    tagsCache = Array.isArray(tj?.items) ? tj.items : [];
  } catch {
    // ignore
  }

  if (libFolderFilterEl) {
    const v = (libFolderFilterEl.value ?? '').toString();
    libFolderFilterEl.innerHTML = `<option value="">All folders</option>` + foldersCache.map((f) => `<option value="${escapeHtml(String(f.id))}">${escapeHtml(String(f.name))}</option>`).join('');
    libFolderFilterEl.value = v;
  }
  if (libTagFilterEl) {
    const v = (libTagFilterEl.value ?? '').toString();
    libTagFilterEl.innerHTML = `<option value="">All tags</option>` + tagsCache.map((t) => `<option value="${escapeHtml(String(t.name))}">${escapeHtml(String(t.name))}</option>`).join('');
    libTagFilterEl.value = v;
  }
  if (metaFoldersListEl) {
    metaFoldersListEl.innerHTML = foldersCache.length
      ? foldersCache
          .map((f) => `<div style="display:flex; justify-content:space-between; gap:10px"><span>${escapeHtml(String(f.name))}</span><button class="btn vvIconBtn err" data-del-folder="${escapeHtml(String(f.id))}" type="button" aria-label="Delete folder" title="Delete">${VV_ICON_SVG.delete}</button></div>`)
          .join('')
      : `<div style="opacity:0.8">No folders yet</div>`;
    metaFoldersListEl.querySelectorAll?.('button[data-del-folder]')?.forEach((b) => {
      b.addEventListener('click', async () => {
        const id = (b.getAttribute('data-del-folder') ?? '').toString();
        if (!id) return;
        if (!confirm('Delete this folder? Notes in it will be moved to no-folder.')) return;
        b.disabled = true;
        try {
          await fetch(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await refreshLibraryMeta();
        } finally {
          b.disabled = false;
        }
      });
    });
  }
  if (metaTagsListEl) {
    metaTagsListEl.innerHTML = tagsCache.length
      ? tagsCache
          .map((t) => `<div style="display:flex; justify-content:space-between; gap:10px"><span>${escapeHtml(String(t.name))}</span><button class="btn vvIconBtn err" data-del-tag="${escapeHtml(String(t.id))}" type="button" aria-label="Delete tag" title="Delete">${VV_ICON_SVG.delete}</button></div>`)
          .join('')
      : `<div style="opacity:0.8">No tags yet</div>`;
    metaTagsListEl.querySelectorAll?.('button[data-del-tag]')?.forEach((b) => {
      b.addEventListener('click', async () => {
        const id = (b.getAttribute('data-del-tag') ?? '').toString();
        if (!id) return;
        if (!confirm('Delete this tag? It will be removed from all notes.')) return;
        b.disabled = true;
        try {
          await fetch(`/api/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await refreshLibraryMeta();
        } finally {
          b.disabled = false;
        }
      });
    });
  }
}

async function refreshSavedSearches() {
  if (!savedSearchSelectEl) return;
  try {
    const r = await fetch('/api/saved-searches');
    const j = await safeJson(r);
    savedSearchesCache = Array.isArray(j?.items) ? j.items : [];
  } catch {
    savedSearchesCache = [];
  }

  const v = (savedSearchSelectEl.value ?? '').toString();
  const recent = loadRecentSearches();

  const savedOpts =
    `<option value="">Saved searches…</option>` +
    (savedSearchesCache ?? [])
      .map((s) => `<option value="${escapeHtml(String(s.id))}">${escapeHtml(String(s.name))}</option>`)
      .join('');

  const recentOpts = recent.length
    ? `<option value="" disabled>— Recent —</option>` +
      recent.map((q, idx) => `<option value="recent:${idx}">${escapeHtml(q)}</option>`).join('')
    : '';

  savedSearchSelectEl.innerHTML = savedOpts + recentOpts;
  savedSearchSelectEl.value = v;
}

function loadRecentSearches() {
  try {
    const raw = localStorage.getItem('vv_recent_searches') || '';
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => (x ?? '').toString().trim()).filter(Boolean).slice(0, 12);
  } catch {
    return [];
  }
}

function recordRecentSearch(q) {
  const s = (q ?? '').toString().trim();
  if (!s) return;
  const arr = loadRecentSearches();
  const next = [s, ...arr.filter((x) => x !== s)].slice(0, 12);
  try {
    localStorage.setItem('vv_recent_searches', JSON.stringify(next));
  } catch {
    // ignore
  }
}

function loadNumberSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function saveNumberSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

function loadBoolSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === '') return fallback;
    return raw === '1' || raw.toLowerCase() === 'true';
  } catch {
    return fallback;
  }
}

function saveBoolSetting(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // ignore
  }
}

async function startRecording(state, { onUi, label }) {
  if (note.isRecording || query.isRecording) {
    setStatus('Stop the current recording first', true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (label === 'note') void abandonServerNoteDraft();
    const mimeType = pickMimeType();
    state.mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND
    });
    state.chunks = [];
    state.audioBlob = null;
    state.previewUrl = '';
    state.isRecording = true;
    state.startedAtMs = Date.now();
    startTimer(state, label === 'note' ? noteTimerEl : queryTimerEl);
    if (label === 'note') {
      lastFullPreviewBundle = null;
      noteFullPreviewGateOk = false;
      noteAllowManualSaveFinal = false;
      noteUsedMicForCurrentBlob = true;
      state.sourceFilename = '';
      state.liveTranscribeTail = Promise.resolve();
      // Switching modes (upload → record) should reset the default title.
      titleEl.value = defaultRecordingTitle();
      resetNewNoteLanguageForRecording();
      if (liveTranscriptEl) {
        liveTranscriptEl.readOnly = true;
        liveTranscriptEl.disabled = false;
      }
      noteLangDetectionComplete = false;
      updateGenerateFullPreviewButtonVisibility();
      state.liveTxStartedAfterLang = false;
      if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
      if (liveTranscriptEl) {
        liveTranscriptEl.value = '';
      }
      clearLiveTxPreviewCountdown();
      if (liveTxStatusEl) liveTxStatusEl.hidden = true;
      setNewNoteTranscriptionStages({ live: 'active', full: 'pending', showRow: true });
      setLiveTxPhaseLabel('Detecting language');
    }
    onUi?.(uiState(state));

    state.mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    });
    state.mediaRecorder.addEventListener('stop', () => {
      const type = state.mediaRecorder?.mimeType || mimeType || 'audio/webm';
      state.audioBlob = new Blob(state.chunks, { type });
      state.previewUrl = URL.createObjectURL(state.audioBlob);
      state.isRecording = false;
      state.durationMs = Math.max(0, Date.now() - (state.startedAtMs || Date.now()));
      stopTimer(state, label === 'note' ? noteTimerEl : queryTimerEl);
      if (label === 'note') {
        // Only start the auto-detect countdown after Stop is pressed (i.e., after recording ends).
        // If live detection already found a language (and user didn't override), apply it immediately.
        const liveLang = (state?.liveDetectedLang ?? '').toString().trim();
        const manualHint = (noteLanguageEl?.value ?? '').toString().trim();
        if (!noteUserOverrodeLanguage && !manualHint && liveLang) {
          applyDetectedLanguageToPillAndSelect(liveLang);
        } else if (noteLanguageWrapEl?.hidden) {
          startNoteLangDetectCountdown();
        }
        notePostRecordPipelinePromise = runNotePostRecordTranscriptionPipeline('recording_stop').finally(() => {
          notePostRecordPipelinePromise = null;
        });
        scheduleServerNoteDraftBackup();
      }
      onUi?.(uiState(state));
      setStatus(
        `Recorded ${label}: ${(state.audioBlob.size / 1024 / 1024).toFixed(2)} MB`
      );
    });

    state.mediaRecorder.start(MEDIARECORDER_TIMESLICE_MS);
    if (label === 'note') {
      startLiveLanguageDetection(state);
    } else if (label === 'search') {
      startLiveQueryTranscript(state);
    }
    setStatus(`Recording ${label}…`);
  } catch (err) {
    setStatus(`Mic error: ${err?.message ?? err}`, true);
    state.isRecording = false;
    onUi?.(uiState(state));
  }
}

function stopRecording(state, { onUi } = {}) {
  if (!state.mediaRecorder) return;
  try {
    state.mediaRecorder.stop();
    for (const track of state.mediaRecorder.stream.getTracks()) track.stop();
  } catch {
    // ignore
  } finally {
    state.isRecording = false;
    stopLiveLanguageDetection(state);
    stopLiveTranscript(state);
    stopLiveQueryTranscript(state);
    stopTimer(state, state === note ? noteTimerEl : queryTimerEl);
    onUi?.(uiState(state));
  }
}

function currentNoteMatchesFullPreviewBundle(b) {
  if (!b || !note?.audioBlob) return false;
  const d = Math.round(note.durationMs || 0);
  const bytes = Number(note.audioBlob.size) || 0;
  const hint = (noteLanguageEl?.value ?? '').toString().trim();
  const stt = getNewNoteSttProvider();
  const bd = Math.round(Number(b.duration_ms) || 0);
  const bb = Number(b.audio_bytes) || 0;
  // Tolerant match: wall-clock duration vs blob metadata can differ slightly; live proxies may alter size reporting.
  const durOk = Math.abs(bd - d) <= 2500;
  const byteTol = Math.max(8192, Math.ceil(bytes * 0.03));
  const byteOk = bytes === 0 ? bb === 0 : Math.abs(bb - bytes) <= byteTol;
  return (
    durOk &&
    byteOk &&
    (b.language_hint ?? '').toString().trim() === hint &&
    String(b.stt_provider ?? '') === String(stt)
  );
}

function previewBundleJsonForSave() {
  if (!lastFullPreviewBundle || !currentNoteMatchesFullPreviewBundle(lastFullPreviewBundle)) return '';
  try {
    return JSON.stringify({
      transcript: lastFullPreviewBundle.transcript,
      segments: lastFullPreviewBundle.segments,
      detected_language: lastFullPreviewBundle.detected_language,
      language_hint: lastFullPreviewBundle.language_hint,
      stt_provider: lastFullPreviewBundle.stt_provider,
      duration_ms: lastFullPreviewBundle.duration_ms,
      audio_bytes: lastFullPreviewBundle.audio_bytes
    });
  } catch {
    return '';
  }
}

async function saveNote() {
  if (!note.audioBlob) return;
  btnSaveNote.disabled = true;
  setStatus('Saving + transcribing…');

  const draftIdForSave = (note.serverDraftId ?? '').toString().trim();

  try {
    const savedDurationMs = Math.round(note.durationMs || 0);
    const savedAudioBytes = Number(note.audioBlob?.size || 0) || 0;

    if (notePostRecordPipelinePromise) {
      setStatus('Waiting for post-record steps to finish…');
      await notePostRecordPipelinePromise.catch(() => {});
    }
    if (transcribeFullPreviewInFlight) {
      setStatus('Waiting for full transcript preview…');
      await transcribeFullPreviewInFlight.catch(() => {});
    }

    const fd = new FormData();
    ensureAutoTitleFilled(note);
    fd.append('display_title', titleEl.value || '');
    fd.append('title', titleEl.value || '');
    fd.append('duration_ms', Math.round(note.durationMs || 0).toString());
    fd.append('language', (noteLanguageEl?.value ?? '').toString());
    fd.append('stt_provider', getNewNoteSttProvider());
    fd.append('source_filename', (note.sourceFilename ?? '').toString());
    if (draftIdForSave) fd.append('draft_id', draftIdForSave);
    fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));
    const pb = previewBundleJsonForSave();
    const editedFmt = vvFormatTranscript(liveTranscriptEl?.value ?? '').trim();
    const bundleFmt = lastFullPreviewBundle
      ? vvFormatTranscript(lastFullPreviewBundle.transcript ?? '').trim()
      : '';
    const unchangedFromBundle = !!(pb && editedFmt && editedFmt === bundleFmt);
    if (pb && unchangedFromBundle) fd.append('preview_bundle', pb);
    else if ((noteFullPreviewGateOk || noteAllowManualSaveFinal) && editedFmt) {
      fd.append('final_transcript', (liveTranscriptEl?.value ?? '').toString());
    }

    const resp = await fetch('/api/notes', { method: 'POST', body: fd });
    if (!resp.ok) {
      const msg = await safeJson(resp);
      const hint =
        draftIdForSave && (resp.status >= 500 || resp.status === 0)
          ? ' A copy of this audio may already be on the server — fix the connection and tap Save again.'
          : '';
      throw new Error((msg?.error || `Upload failed (${resp.status})`) + hint);
    }
    const data = await safeJson(resp);

    titleEl.value = '';
    note.serverDraftId = '';
    try {
      sessionStorage.removeItem('vv_active_note_draft_id');
    } catch {
      // ignore
    }
    resetRecorder(note);
    previewNote.hidden = true;
    previewNote.src = '';
    if (noteLanguageEl) noteLanguageEl.value = '';
    if (uploadNoteEl) uploadNoteEl.value = '';
    if (uploadNoteNameEl) uploadNoteNameEl.textContent = 'No file selected';
    if (noteDetectedLangEl) {
      noteDetectedLangEl.hidden = true;
      noteDetectedLangEl.textContent = 'Lang: —';
    }
    syncVisibility();

    const id = (data?.id ?? '').toString().trim();
    const savedStatus = (data?.status ?? '').toString();
    if (id && savedStatus === 'processing') {
      showNewNoteProcessingStatus(id, {
        durationMs: savedDurationMs,
        audioBytes: savedAudioBytes,
        retranscribe: (data?.transcribe_mode ?? '').toString().trim() === 'retranscribe'
      });
    }
    setStatus(
      savedStatus === 'ready'
        ? 'Saved.'
        : 'Saved. Running full transcription on the server (authoritative transcript when ready)…'
    );
    expandedNoteIds.clear();
    expandedNoteIdsFromSearchMatch.clear();
    await refreshResults(qEl.value);
    setNewNotePanelOpen(false);
    if (id) pollNoteUntilDone(id);

    titleEl.value = defaultNoteTitleFromState(note);
    lastFullPreviewBundle = null;
  } catch (err) {
    const backupHint = draftIdForSave
      ? ' Try Save again — a server-side backup of the audio may be available.'
      : '';
    setStatus(`Save/transcribe error: ${err?.message ?? err}${backupHint}`, true);
    btnSaveNote.disabled = false;
  }
}

async function refreshResults(q = '') {
  const vvT0 = performance.now();
  const prevScroll = resultsEl.scrollTop;
  // Any "Search" refresh should show the results list (Quick answer may hide it separately).
  resultsEl.hidden = false;
  resultsEl.innerHTML = '';
  const isSearch = !!(q && q.trim());
  const queryText = (q ?? '').toString().trim();
  let vvFetchMs = 0;
  let vvRenderMs = 0;

  if (!isSearch) {
    setStatus('Displaying Saved Notes…');
  }

  if (!isSearch) {
    for (const id of expandedNoteIdsFromSearchMatch) {
      expandedNoteIds.delete(id);
    }
    expandedNoteIdsFromSearchMatch.clear();
  }

  if (isSearch) recordRecentSearch(queryText);

  let items = [];
  if (!isSearch) {
    // Empty query: show saved notes (keyword path).
    const fetchT0 = performance.now();
    const url = new URL('/api/notes', window.location.origin);
  const resp = await fetch(url.toString());
  if (!resp.ok) {
      resultsEl.innerHTML = `<div class="note err resultsBanner">Failed to load notes</div>`;
      syncProcessingNotesPoll([]);
    setStatus(`Failed to load notes (${resp.status})`, true);
    return;
  }
  const data = await resp.json();
    vvFetchMs = performance.now() - fetchT0;
    items = Array.isArray(data?.items) ? data.items : [];
    // Pin starred notes to the top in the normal Saved Notes view.
    try {
      const withIdx = items.map((it, idx) => ({ it, idx }));
      withIdx.sort((a, b) => {
        const af = Number(a?.it?.is_favorite ?? 0) ? 1 : 0;
        const bf = Number(b?.it?.is_favorite ?? 0) ? 1 : 0;
        if (af !== bf) return bf - af;
        return (a?.idx ?? 0) - (b?.idx ?? 0);
      });
      items = withIdx.map((x) => x.it);
    } catch {
      // ignore
    }
  } else {
    // Hybrid blend: semantic + keyword (FTS).
    const urlSem = new URL('/api/semantic', window.location.origin);
    urlSem.searchParams.set('q', queryText);
    urlSem.searchParams.set('k', '15');
    const urlFts = new URL('/api/notes', window.location.origin);
    urlFts.searchParams.set('q', queryText);
    urlFts.searchParams.set('limit', '50');

    const [semResp, ftsResp] = await Promise.all([fetch(urlSem.toString()), fetch(urlFts.toString())]);
    if (!semResp.ok && !ftsResp.ok) {
      resultsEl.innerHTML = `<div class="note err resultsBanner">Failed to load notes</div>`;
      syncProcessingNotesPoll([]);
      setStatus('Failed to load search results', true);
      return;
    }
    const semJson = await safeJson(semResp);
    const ftsJson = await safeJson(ftsResp);
    const semItems = Array.isArray(semJson?.items) ? semJson.items : [];
    const ftsItems = Array.isArray(ftsJson?.items) ? ftsJson.items : [];

    const byId = new Map();
    /** Semantic hits are chunk-shaped; merging `{...fts, ...sem}` can overwrite note fields with null/empty from JSON. */
    function repairHybridMergedNote(fts, merged) {
      const out = { ...merged };
      const ftsLang = (fts?.language ?? '').toString().trim();
      if (!(out.language ?? '').toString().trim() && ftsLang) out.language = fts.language;
      const ftsBody = (fts?.body ?? '').toString();
      if (!(out.body ?? '').toString().trim() && ftsBody.trim()) out.body = fts.body;
      const ftsDt = (fts?.display_title ?? '').toString().trim();
      if (!(out.display_title ?? '').toString().trim() && ftsDt) out.display_title = fts.display_title;
      if (!(out?.stt_provider ?? '').toString().trim() && (fts?.stt_provider ?? '').toString().trim()) {
        out.stt_provider = fts.stt_provider;
      }
      if ((out?.status ?? '').toString() === 'processing') {
        const u = Number(out.processing_pending_units);
        const ftsU = Number(fts?.processing_pending_units);
        if (!(Number.isFinite(u) && u > 0) && Number.isFinite(ftsU) && ftsU > 0) {
          out.processing_pending_units = fts.processing_pending_units;
        }
        if (!(out?.processing_running_locked_at ?? '').toString().trim() && (fts?.processing_running_locked_at ?? '').toString().trim()) {
          out.processing_running_locked_at = fts.processing_running_locked_at;
        }
        if (!(out?.processing_coarse_stage ?? '').toString().trim() && (fts?.processing_coarse_stage ?? '').toString().trim()) {
          out.processing_coarse_stage = fts.processing_coarse_stage;
        }
        if (!(out?.transcribe_mode ?? '').toString().trim() && (fts?.transcribe_mode ?? '').toString().trim()) {
          out.transcribe_mode = fts.transcribe_mode;
        }
      }
      return out;
    }
    for (const it of semItems) {
      const id = (it?.id ?? '').toString();
      if (!id) continue;
      const topScore = Number(it?.matches?.[0]?.score ?? 0) || 0;
      byId.set(id, { ...it, _vvSort: 10_000 + topScore });
    }
    for (let i = 0; i < ftsItems.length; i += 1) {
      const it = ftsItems[i];
      const id = (it?.id ?? '').toString();
      if (!id) continue;
      if (!byId.has(id)) {
        byId.set(id, { ...it, _vvSort: 1000 - i });
      } else {
        const cur = byId.get(id);
        const merged = { ...it, ...cur, matches: cur?.matches ?? it?.matches ?? [], _vvSort: cur?._vvSort ?? 0 };
        byId.set(id, repairHybridMergedNote(it, merged));
      }
    }
    items = Array.from(byId.values());
    items.sort((a, b) => (Number(b?._vvSort ?? 0) || 0) - (Number(a?._vvSort ?? 0) || 0));
    items = items.map((x) => {
      const { _vvSort, ...rest } = x || {};
      return rest;
    });

    // Only show notes that appear in both retrieval paths when both succeeded—drops
    // semantic-only or keyword-only hits so tiles match the combined relevance intent.
    if (semResp.ok && ftsResp.ok && semItems.length > 0 && ftsItems.length > 0) {
      const semIds = new Set(semItems.map((x) => (x?.id ?? '').toString()).filter(Boolean));
      const ftsIds = new Set(ftsItems.map((x) => (x?.id ?? '').toString()).filter(Boolean));
      items = items.filter((it) => {
        const id = (it?.id ?? '').toString();
        return id && semIds.has(id) && ftsIds.has(id);
      });
    }
  }

  lastSearchItems = Array.isArray(items) ? items : [];
  lastSearchQuery = isSearch ? queryText : '';
  if (newNotePendingProcessId) {
    const match = lastSearchItems.find((it) => (it?.id ?? '').toString() === newNotePendingProcessId);
    if (match) {
      const st = (match?.status ?? '').toString();
      if (st && st !== 'processing') hideNewNoteProcessingStatus();
    }
  }
  // Don't auto-render Quick answer. It should only appear when Quick answer is pressed.
  if (answerWrapEl) {
    answerWrapEl.hidden = true;
    answerWrapEl.innerHTML = '';
  }
  if (btnAskEl) {
    // Quick answer button is controlled by syncVisibility() now (semantic mode + non-empty query).
    // Leave it alone here to avoid conflicting UI updates.
  }
  // Advanced search UI removed.

  if (items.length === 0) {
    resultsEl.innerHTML = `<div class="note resultsBanner"><div class="pill">No results</div></div>`;
    syncProcessingNotesPoll([]);
    if (!isSearch) setStatus('Ready');
    return;
  }

  // Auto-expand Processes when any note is in error.
  const hasErrorNote = items.some((it) => (it?.status ?? '').toString() === 'error');
  if (hasErrorNote) {
    expandProcessesSide();
  }

  const hideReprocessWhileBusy = items.some((it) => (it?.status ?? '').toString() === 'processing');

  const renderT0 = performance.now();
  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    const isLastNote = idx === items.length - 1;
    const note = document.createElement('div');

    const created = new Date(item.created_at).toLocaleString();
    const createdAtIso = (item.created_at ?? '').toString();
    const updatedAtIso = (item.updated_at ?? '').toString();
    /** Server sets `updated_at` when reprocess/retry starts (`processing`); use for elapsed timer so it resets on each reprocess. */
    const processingSinceIso = updatedAtIso || createdAtIso;
    const status = (item.status ?? '').toString();
    if (status !== 'processing') {
      const nid = (item.id ?? '').toString();
      procTimerByNoteId.delete(nid);
    }
    const errText = (item.error ?? '').toString().trim();
    const durationMs = Number(item.duration_ms ?? 0) || 0;
    const lang = formatNoteLanguageMeta(item.language ?? '');
    const fav = Number(item.is_favorite ?? 0) ? true : false;
    const procPaused = Number(item.processing_paused ?? 0) ? true : false;
    const displayTitleRaw = (item.display_title ?? '').toString().trim();
    const displayTitleEsc = displayTitleRaw ? escapeHtml(displayTitleRaw) : '';
    const listHeadline = escapeHtml(displayTitleRaw || (item.title ?? '').toString().trim() || 'Untitled');
    const titleBodySepHtml = displayTitleEsc
      ? `<div class="noteDisplayTitleBlock">${displayTitleEsc}</div><hr class="noteTitleBodyDivider" />`
      : '';
    const rawBody = (item.body ?? '').toString();
    const matchSegs = isSearch ? normalizeMatchSegments(item?.matches ?? item?.best_match ?? null) : [];
    const body =
      isSearch && matchSegs.length
        ? highlightTranscriptHtml(rawBody, matchSegs, { mode: 'search' })
        : escapeHtml(rawBody);
    const collapsedBodyPreview =
      status === 'ready' && (item.body ?? '').toString().trim()
        ? escapeHtml(truncateNotePreviewPlain(item.body || '', 280))
        : '';
    const collapsedTitleTextEsc = displayTitleEsc || escapeHtml((item.title ?? '').toString().trim() || 'Untitled');
    const collapsedTitleRowHtml =
      status === 'ready' && collapsedTitleTextEsc
        ? `<div class="noteCollapsedTitleRow"><span class="noteCollapsedTitleText">${collapsedTitleTextEsc}</span><span class="noteCollapsedTitleSep" aria-hidden="true"></span><button class="btn vvIconBtn noteStarInline${
            fav ? ' primary' : ''
          }" data-fav="${item.id}" type="button" aria-label="${
            fav ? 'Unstar note' : 'Star note'
          }" title="${fav ? 'Starred' : 'Star'}">${fav ? VV_ICON_SVG.starOn : VV_ICON_SVG.starOff}</button></div>`
        : '';
    const savedCardInnerHtml =
      status === 'ready' && (collapsedTitleRowHtml || collapsedBodyPreview)
        ? `${collapsedTitleRowHtml}${
            collapsedBodyPreview ? `<div class="noteCollapsedBodyPreview">${collapsedBodyPreview}</div>` : ''
          }`
        : '';
    const collapsedTranscriptHtml = savedCardInnerHtml
      ? `<div class="noteSavedCard noteCollapsedTranscriptShell" data-collapsed-expand="1" role="button" tabindex="0" aria-label="Expand note">${savedCardInnerHtml}</div>`
      : '';

    const hasCollapsedShell = !!collapsedTranscriptHtml;
    note.className = `note noteCollapsed${hasCollapsedShell ? ' note--hasCollapsedShell' : ''}${
      status === 'processing' && !hasCollapsedShell ? ' note--processingInCard' : ''
    }`;

    const metaParts = [];
    if (durationMs > 0) metaParts.push(formatMs(durationMs));
    if (lang) metaParts.push(lang);
    const fileMetaHtml = metaParts.length
      ? `<span class="noteFileMeta">${escapeHtml(metaParts.join(' · '))}</span>`
      : '';

    syncProcTimerFromServerPaused(item.id, processingSinceIso, procPaused, status, item);
    const timerAttrIso = timerAttrIsoForNote(item.id, processingSinceIso);
    const baseProcMs = totalProcessingEstimateMsForItem(item);
    const procPendingUnits = status === 'processing' ? processingPendingUnitsForItem(item) : 0;
    const procLockedAt =
      status === 'processing' ? (item.processing_running_locked_at ?? '').toString().trim() : '';
    const scaledProcMs = status === 'processing' ? scaledProcessingBudgetMsForItem(item) : baseProcMs;
    const estProcAttr = String(scaledProcMs);
    const sinceT = Date.parse(processingSinceIso) || Date.now();
    const elapsed0 = Math.max(0, Date.now() - sinceT);
    const procStage = (item.processing_coarse_stage ?? '').toString().trim();
    const isRetranscribeQueue =
      status === 'processing' && (item.transcribe_mode ?? '').toString().trim() === 'retranscribe';
    const procHeadLabel = isRetranscribeQueue ? 'Re-transcribing to save' : 'Processing';
    const initProcProg =
      status === 'processing'
        ? processingProgressFromAttrs({
            baseMs: baseProcMs,
            units: procPendingUnits,
            lockedAt: procLockedAt,
            elapsedWallMs: elapsed0
          })
        : { pct: 100, pastBudget: false };
    const procChipTxt = formatProcessingProgressChipText({
      ...initProcProg,
      coarseStage: procStage,
      retranscribeFallback: isRetranscribeQueue
    });

    const headerActionsHtml =
      status === 'ready' || status === 'error'
        ? `<span class="noteHeaderActions" style="display:inline-flex; align-items:center; gap:8px">
             <button class="btn vvIconBtn" data-play="${item.id}" type="button" aria-label="Play audio" title="Play audio">${VV_ICON_SVG.play}</button>
             <button class="btn vvIconBtn err" data-delete="${item.id}" type="button" aria-label="Delete note" title="Delete note">${VV_ICON_SVG.delete}</button>
             <button class="btn vvIconBtn" data-dl-text="${item.id}" type="button" aria-label="Download transcript" title="Download transcript">${VV_ICON_SVG.doc}</button>
             <button class="btn vvIconBtn" data-edit="${item.id}" type="button" aria-label="Edit note" title="Edit">${VV_ICON_SVG.edit}</button>
             ${
               status === 'error' || !hideReprocessWhileBusy
                 ? `<button class="btn vvIconBtn" data-reprocess="${item.id}" type="button" aria-label="Reprocess note" title="Reprocess">${VV_ICON_SVG.reprocess}</button>`
                 : ''
             }
           </span>`
        : '';

    const noteDetailsHtml = `
      <div class="noteDetails" hidden>
        <div class="noteTranscript">
          <div class="noteBody">${
            status === 'processing'
              ? `<span class="pill">${isRetranscribeQueue ? 'Re-transcribing to save…' : 'Transcribing…'}</span>`
              : status === 'error'
                ? `${titleBodySepHtml}<div class="pill err">Transcription failed</div><div style="margin-top:8px">${escapeHtml(
                    errText || 'Unknown error'
                  )}</div>`
                : `${titleBodySepHtml}${body}`
          }</div>
        </div>

        <div class="row notePlaybackRow" style="margin-top:8px; margin-bottom:0; gap:10px; flex-wrap:wrap; align-items:center">
          <span class="notePlayerCluster">
            <audio class="audio noteInlinePlayer" controls hidden></audio>
            <button class="btn vvIconBtn" data-dl-audio="${item.id}" type="button" aria-label="Download audio" title="Download audio">${VV_ICON_SVG.download}</button>
            <button class="btn" data-loop="${item.id}" type="button" aria-pressed="false" title="Loop played segments" hidden>Loop segment</button>
          </span>
        </div>

        <div class="editBox" hidden>
          <label class="label">
            Title
            <input class="input editTitle" />
          </label>
          <hr class="noteTitleBodyDivider editTitleBodySep" />
          <label class="label">
            Transcript
            <textarea class="textarea editBody" rows="16"></textarea>
          </label>
          <div class="noteScrollHint" style="margin-bottom:12px" hidden>More transcript below</div>
          <div class="row" style="margin-bottom:0">
            <button class="btn primary vvIconBtn" data-save="${item.id}" type="button" aria-label="Save changes" title="Save">${VV_ICON_SVG.save}</button>
            <button class="btn vvIconBtn" data-cancel="${item.id}" type="button" aria-label="Cancel editing" title="Cancel">${VV_ICON_SVG.cancel}</button>
          </div>
        </div>
      </div>
    `;

    if (hasCollapsedShell) {
      note.innerHTML = `
      <div class="noteSummary">
        ${collapsedTranscriptHtml}
        <div class="noteSummaryToolbar">
          <span class="noteStatus ready">Ready</span>
          ${fileMetaHtml}
          <span class="noteToolbarDate noteMeta">${escapeHtml(created)}</span>
          <span class="noteToolbarSpacer" aria-hidden="true"></span>
          <div class="noteCollapseActions">
            ${headerActionsHtml}
            <button class="btn vvIconBtn ${fav ? 'primary' : ''}" data-fav="${item.id}" type="button" aria-label="${
              fav ? 'Unstar note' : 'Star note'
            }" title="${fav ? 'Starred' : 'Star'}">${fav ? VV_ICON_SVG.starOn : VV_ICON_SVG.starOff}</button>
            <button class="btn vvIconBtn" data-toggle="${item.id}" type="button" aria-label="Expand note" title="Expand">${VV_ICON_SVG.chevronDown}</button>
          </div>
        </div>
      </div>
      ${noteDetailsHtml}
    `;
    } else {
      note.innerHTML = `
      <div class="noteSummary">
        <div class="noteTitleRow">
          <div class="noteTitleCluster">
            <div class="noteTitle">${listHeadline}</div>
            ${fileMetaHtml}
          </div>
          <div style="display:flex; align-items:center; gap:10px">
            ${headerActionsHtml}
            <div class="noteMeta noteTitleStamp">${created}</div>
          </div>
        </div>
        <div style="margin-top:6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
          <button class="btn vvIconBtn ${fav ? 'primary' : ''}" data-fav="${item.id}" type="button" aria-label="${
            fav ? 'Unstar note' : 'Star note'
          }" title="${fav ? 'Starred' : 'Star'}">${fav ? VV_ICON_SVG.starOn : VV_ICON_SVG.starOff}</button>
          ${
            status
              ? status === 'ready'
                ? `<span class="noteStatus ready">Ready</span>`
                : status === 'processing'
                  ? `<span class="noteStatus">${escapeHtml(procHeadLabel)} <span class="noteProcessingTime" data-note-id="${escapeHtml(
                      String(item.id)
                    )}" data-processing-since="${escapeHtml(
                      timerAttrIso
                    )}" data-estimated-total-ms="${escapeHtml(estProcAttr)}" data-processing-base-ms="${escapeHtml(
                      String(baseProcMs)
                    )}" data-processing-pending-units="${escapeHtml(
                      String(procPendingUnits)
                    )}" data-processing-locked-at="${escapeHtml(
                      procLockedAt
                    )}" data-processing-stage="${escapeHtml(
                      procStage
                    )}" data-retranscribe-fallback="${isRetranscribeQueue ? '1' : '0'}" title="Until the time estimate is used up: approximate % from audio length vs elapsed. After that: working… When the server reports starting/running on the job queue (refreshes with this list).">${escapeHtml(
                      procChipTxt
                    )}</span></span>`
                : status === 'error'
                    ? `<span class="noteStatus err">Error</span>`
                    : `<span class="noteStatus">${escapeHtml(status)}</span>`
              : ''
          }
          ${
            status === 'error'
              ? `<button class="btn vvIconBtn err" data-delete="${item.id}" type="button" aria-label="Delete note" title="Delete note">${VV_ICON_SVG.delete}</button>`
              : ''
          }
          ${
            status === 'ready' || status === 'error'
              ? `<button class="btn vvIconBtn" data-toggle="${item.id}" type="button" aria-label="Expand note" title="Expand">${VV_ICON_SVG.chevronDown}</button>`
              : ''
          }
          ${
            status === 'processing'
              ? `<span class="noteProcActions" style="display:inline-flex; gap:10px; align-items:center; flex-wrap:nowrap; flex-shrink:0"><button class="btn ${procPaused ? 'primary' : ''}" data-proc-toggle="${item.id}" type="button" title="Pause/resume jobs for this note">${procPaused ? 'Resume processing' : 'Pause processing'}</button><button class="btn vvIconBtn err" data-proc-stop="${item.id}" type="button" aria-label="Stop transcription" title="Stop transcription for this note">${VV_ICON_SVG.stop}</button></span>`
              : ''
          }
        </div>

        ${collapsedTranscriptHtml}

      </div>

      ${noteDetailsHtml}
    `;
    }

    const summary = note.querySelector('.noteSummary');
    const actionsMenu = null;
    const details = note.querySelector('.noteDetails');
    const scrollHint = note.querySelector('.noteScrollHint');

    const syncCollapsedTranscriptShell = () => {
      const shell = note.querySelector('.noteCollapsedTranscriptShell');
      if (!shell) return;
      shell.hidden = !note.classList.contains('noteCollapsed');
    };

    const editBox = note.querySelector('.editBox');
    const transcriptBox = note.querySelector('.noteTranscript');
    const editBody = note.querySelector('.editBody');

    const btnToggle = note.querySelector('button[data-toggle]');
    if (btnToggle) {
      // If this is a search and the server provided a best-match segment, auto-expand.
      if (isSearch && item?.best_match && status === 'ready') {
        expandedNoteIds.add(item.id);
        expandedNoteIdsFromSearchMatch.add(item.id);
      }

      if (expandedNoteIds.has(item.id)) {
        details.hidden = false;
        note.classList.add('noteExpanded');
        note.classList.remove('noteCollapsed');
        btnToggle.innerHTML = VV_ICON_SVG.arrowLeft;
        btnToggle.setAttribute('aria-label', 'Collapse note');
        btnToggle.setAttribute('title', 'Collapse');
        scheduleExpandedNoteScroll(note, isLastNote);
        syncCollapsedTranscriptShell();
      }
      btnToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !details.hidden;
        details.hidden = isOpen;
        note.classList.toggle('noteExpanded', !isOpen);
        note.classList.toggle('noteCollapsed', isOpen);
        btnToggle.innerHTML = isOpen ? VV_ICON_SVG.chevronDown : VV_ICON_SVG.arrowLeft;
        btnToggle.setAttribute('aria-label', isOpen ? 'Expand note' : 'Collapse note');
        btnToggle.setAttribute('title', isOpen ? 'Expand' : 'Collapse');
        if (isOpen) expandedNoteIds.add(item.id);
        else {
          expandedNoteIds.delete(item.id);
          expandedNoteIdsFromSearchMatch.delete(item.id);
        }
        if (!isOpen) {
          scheduleExpandedNoteScroll(note, isLastNote);
          requestAnimationFrame(() => {
            if (editBox && !editBox.hidden) updateScrollHint(editBody, scrollHint);
          });
        }
        syncCollapsedTranscriptShell();
      });
    }

    syncCollapsedTranscriptShell();

    const btnActionsToggle = null;

    // Playback polish: loop for this note (only show while audio is playing).
    const audioEl = note.querySelector('audio');
    const loopBtn = note.querySelector(`button[data-loop="${CSS.escape(String(item.id))}"]`);
    if (loopBtn) {
      const sync = () => {
        loopBtn.setAttribute('aria-pressed', loopSegments ? 'true' : 'false');
        loopBtn.classList.toggle('primary', loopSegments);
      };
      sync();
      loopBtn.hidden = true;
      loopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        loopSegments = !loopSegments;
        saveBoolSetting('vv_loop_segments', loopSegments);
        sync();
      });
    }

    // Folder dropdown is intentionally not rendered when there are no folders.
    // (Removed) folder assignment UI.

    // Favorite toggle.
    note.querySelectorAll('button[data-fav]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = (b.getAttribute('data-fav') ?? '').toString();
        if (!id) return;
        const next = (b.classList?.contains?.('primary') ?? false) ? 0 : 1;
        try {
          await fetch(`/api/notes/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_favorite: next })
          });
          await refreshResults(qEl.value);
        } catch {
          // ignore
        }
      });
    });

    // Per-note processing controls (pause/resume + stop + priority for queued jobs).
    const btnProcToggle = note.querySelector(`button[data-proc-toggle="${CSS.escape(String(item.id))}"]`);
    if (btnProcToggle) {
      btnProcToggle.addEventListener('click', async (e) => {
        e.preventDefault();
        const nid = (item.id ?? '').toString();
        try {
          if (procPaused) {
            const st = procTimerByNoteId.get(nid);
            const span = note.querySelector(`.noteProcessingTime[data-note-id="${CSS.escape(nid)}"]`);
            const estTotal =
              Number(span?.getAttribute('data-estimated-total-ms') ?? '') || DEFAULT_PROCESSING_ESTIMATE_MS;
            let elapsed = 0;
            if (typeof st?.frozenRemainingMs === 'number') {
              elapsed = Math.max(0, estTotal - st.frozenRemainingMs);
            } else if (typeof st?.frozenMs === 'number') {
              elapsed = st.frozenMs;
            }
            procTimerByNoteId.set(nid, {
              paused: false,
              baseIso: new Date(Date.now() - elapsed).toISOString()
            });
            await fetch(`/api/notes/${encodeURIComponent(nid)}/resume-processing`, { method: 'POST' });
          } else {
            const span = note.querySelector(`.noteProcessingTime[data-note-id="${CSS.escape(nid)}"]`);
            const iso = span?.getAttribute('data-processing-since') || '';
            const estTotal =
              Number(span?.getAttribute('data-estimated-total-ms') ?? '') || DEFAULT_PROCESSING_ESTIMATE_MS;
            const t0 = Date.parse(iso) || Date.now();
            const elapsed = Math.max(0, Date.now() - t0);
            const baseMs = Number(span?.getAttribute('data-processing-base-ms') ?? '') || DEFAULT_PROCESSING_ESTIMATE_MS;
            const unitsRaw = Number(span?.getAttribute('data-processing-pending-units') ?? '100');
            const units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : 100;
            const lockedAt = (span?.getAttribute('data-processing-locked-at') ?? '').toString().trim();
            const stage = (span?.getAttribute('data-processing-stage') ?? '').toString().trim();
            const frozenProg = processingProgressFromAttrs({
              baseMs,
              units,
              lockedAt,
              elapsedWallMs: elapsed
            });
            const rtf = (span?.getAttribute('data-retranscribe-fallback') ?? '') === '1';
            const frozenChipText = formatProcessingProgressChipText({
              ...frozenProg,
              coarseStage: stage,
              retranscribeFallback: rtf
            });
            procTimerByNoteId.set(nid, {
              paused: true,
              frozenRemainingMs: Math.max(0, estTotal - elapsed),
              estimatedMs: estTotal,
              frozenPercentLeft: frozenProg.pct,
              frozenPastBudget: frozenProg.pastBudget,
              frozenCoarseStage: stage,
              frozenChipText
            });
            await fetch(`/api/notes/${encodeURIComponent(nid)}/pause-processing`, { method: 'POST' });
          }
          await refreshResults(qEl.value);
        } catch {
          // ignore
        }
      });
    }

    const btnProcStop = note.querySelector(`button[data-proc-stop="${CSS.escape(String(item.id))}"]`);
    if (btnProcStop) {
      btnProcStop.addEventListener('click', async (e) => {
        e.preventDefault();
        const nid = (item.id ?? '').toString();
        const ok = confirm('Stop transcription for this note? Queued work will be cancelled.');
        if (!ok) return;
        btnProcStop.disabled = true;
        try {
          await fetch(`/api/notes/${encodeURIComponent(nid)}/stop-processing`, { method: 'POST' });
          procTimerByNoteId.delete(nid);
          setStatus('Processing stopped');
          await refreshResults(qEl.value);
        } catch {
          // ignore
        } finally {
          btnProcStop.disabled = false;
        }
      });
    }

    // Tags removed.

    const playBtns = Array.from(note.querySelectorAll('button[data-play]'));
    const audio = note.querySelector('audio');
    // Ready notes expose playback controls; processing/error notes omit those controls.
    if (playBtns.length && audio) {
    const onToggleFullAudio = async (btn, e) => {
      e.stopPropagation();
      const src = `/api/notes/${encodeURIComponent(item.id)}/audio`;
      const isPlaying = !audio.paused && !audio.ended && audio.currentTime > 0;
      if (isPlaying) {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          // ignore
        }
        for (const b of playBtns) {
          try {
            b.innerHTML = VV_ICON_SVG.play;
            b.setAttribute('aria-label', 'Play audio');
            b.setAttribute('title', 'Play audio');
          } catch {
            // ignore
          }
        }
        try {
          const loopBtn = note.querySelector(`button[data-loop="${CSS.escape(String(item.id))}"]`);
          if (loopBtn) loopBtn.hidden = true;
        } catch {
          // ignore
        }
        return;
      }

      audio.hidden = false;
      if (audio.src !== new URL(src, window.location.origin).toString()) {
        audio.src = src;
      }
      try {
          try {
            audio.playbackRate = playbackRate || 1;
          } catch {
            // ignore
          }
        await audio.play();
          // Follow along word-by-word (ElevenLabs word timestamps).
          await ensureNoteWordSpans(item.id, note);
          startWordFollowAll(audio, note.querySelector('.noteBody'));
        for (const b of playBtns) {
          try {
            b.innerHTML = VV_ICON_SVG.stop;
            b.setAttribute('aria-label', 'Stop audio');
            b.setAttribute('title', 'Stop audio');
          } catch {
            // ignore
          }
        }
        try {
          const loopBtn = note.querySelector(`button[data-loop="${CSS.escape(String(item.id))}"]`);
          if (loopBtn) loopBtn.hidden = false;
        } catch {
          // ignore
        }
      } catch {
        // ignore autoplay restrictions
      }
    };
    for (const b of playBtns) {
      b.addEventListener('click', (e) => onToggleFullAudio(b, e));
    }

    audio.addEventListener('ended', () => {
      for (const b of playBtns) {
        try {
          b.innerHTML = VV_ICON_SVG.play;
          b.setAttribute('aria-label', 'Play audio');
          b.setAttribute('title', 'Play audio');
        } catch {
          // ignore
        }
      }
      try {
        const loopBtn = note.querySelector(`button[data-loop="${CSS.escape(String(item.id))}"]`);
        if (loopBtn) loopBtn.hidden = true;
      } catch {
        // ignore
      }
    });
    }

    // Search highlight playback: clicking a highlighted match plays just that range.
    if (isSearch && status === 'ready' && audio) {
      const hitSpans = Array.from(note.querySelectorAll('.vvSearchHit[data-seg-start][data-seg-end]'));
      for (const s of hitSpans) {
        s.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeAllActionMenus();

          const start = Number(s.getAttribute('data-seg-start') || '0');
          const end = Number(s.getAttribute('data-seg-end') || '0');
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

          // Clear prior playing highlight.
          for (const other of hitSpans) other.classList.remove('playing');

          const wantSrc = `/api/notes/${encodeURIComponent(item.id)}/audio`;
          audio.hidden = false;
          if (audio.src !== new URL(wantSrc, window.location.origin).toString()) {
            audio.src = wantSrc;
            try {
              audio.load();
            } catch {
              // ignore
            }
          }

          s.classList.add('playing');
          // Ensure we can highlight each word while the match-range plays.
          try {
            await ensureNoteWordSpans(item.id, note);
            startWordFollowAll(audio, note.querySelector('.noteBody'));
          } catch {
            // ignore
          }
          const cleanup = () => {
            try {
              s.classList.remove('playing');
            } catch {
              // ignore
            }
          };
          audio.addEventListener('pause', cleanup, { once: true });
          audio.addEventListener('ended', cleanup, { once: true });

          playAudioRange(audio, start, end, { loop: loopSegments, rate: playbackRate });
          try {
            const loopBtn = note.querySelector(`button[data-loop="${CSS.escape(String(item.id))}"]`);
            if (loopBtn) loopBtn.hidden = false;
          } catch {
            // ignore
          }
        });
      }
    }

    const editTitle = note.querySelector('.editTitle');
    const editBtns = Array.from(note.querySelectorAll('button[data-edit]'));
    const deleteBtns = Array.from(note.querySelectorAll('button[data-delete]'));
    const reprocessBtns = Array.from(note.querySelectorAll('button[data-reprocess]'));
    const dlAudioBtns = Array.from(note.querySelectorAll('button[data-dl-audio]'));
    const dlTextBtns = Array.from(note.querySelectorAll('button[data-dl-text]'));
    const btnEdit = editBtns[0] || null;
    const btnDelete = deleteBtns[0] || null;
    const btnRemove = note.querySelector('button[data-remove]');
    const btnDlAudio = null;
    const btnDlText = null;
    const btnSave = note.querySelector('button[data-save]');
    const btnCancel = note.querySelector('button[data-cancel]');

    const refreshEditScrollHint = () => updateScrollHint(editBody, scrollHint);
    editBody?.addEventListener('scroll', refreshEditScrollHint);
    editBody?.addEventListener('input', refreshEditScrollHint);

    const collapsedExpandShell = note.querySelector('[data-collapsed-expand="1"]');
    if (collapsedExpandShell && btnToggle) {
      const expandFromCollapsedShell = (e) => {
      e.stopPropagation();
        if (!note.classList.contains('noteCollapsed')) return;
        btnToggle.click();
      };
      collapsedExpandShell.addEventListener('click', expandFromCollapsedShell);
      collapsedExpandShell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          expandFromCollapsedShell(e);
        }
      });
    }

    const syncEditMenuBtn = () => {
      for (const b of editBtns) b.hidden = note.classList.contains('isEditing');
    };
    syncEditMenuBtn();

    for (const btnEdit of editBtns) {
      btnEdit.addEventListener('click', async (e) => {
      e.stopPropagation();
        // Editing UI lives inside details; ensure it's visible.
        if (details?.hidden) {
          details.hidden = false;
          note.classList.add('noteExpanded');
          note.classList.remove('noteCollapsed');
          if (btnToggle) {
            btnToggle.innerHTML = VV_ICON_SVG.arrowLeft;
            btnToggle.setAttribute('aria-label', 'Collapse note');
            btnToggle.setAttribute('title', 'Collapse');
          }
          expandedNoteIds.add(item.id);
          scheduleExpandedNoteScroll(note, isLastNote);
          syncCollapsedTranscriptShell();
        }
        const willShow = !!editBox.hidden;
        editBox.hidden = !willShow;
        if (transcriptBox) transcriptBox.hidden = willShow;
        note.classList.toggle('isEditing', willShow);
        syncEditMenuBtn();
        if (willShow) {
          try {
            const resp = await fetch(`/api/notes/${encodeURIComponent(item.id)}`);
            const full = await safeJson(resp);
            if (!resp.ok) throw new Error(full?.error || `Load failed (${resp.status})`);
            editTitle.value = (full?.display_title ?? full?.title ?? item.display_title ?? item.title ?? '').toString();
            editBody.value = (full?.body ?? item.body ?? '').toString();
          } catch {
            editTitle.value = (item.display_title ?? item.title ?? '').toString();
      editBody.value = (item.body ?? '').toString();
          }
          requestAnimationFrame(refreshEditScrollHint);
        }
      });
    }

    btnCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      editBox.hidden = true;
      if (transcriptBox) transcriptBox.hidden = false;
      note.classList.remove('isEditing');
      syncEditMenuBtn();
    });

    btnSave.addEventListener('click', async (e) => {
      e.stopPropagation();
      btnSave.disabled = true;
      setStatus('Saving changes…');
      try {
        const resp = await fetch(`/api/notes/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_title: editTitle.value || '',
            body: editBody.value || ''
          })
        });
        if (!resp.ok) {
          const msg = await safeJson(resp);
          throw new Error(msg?.error || `Save failed (${resp.status})`);
        }
        editBox.hidden = true;
        if (transcriptBox) transcriptBox.hidden = false;
        note.classList.remove('isEditing');
        syncEditMenuBtn();
        setStatus('Saved');
        await refreshResults(qEl.value);
      } catch (e) {
        setStatus(`Save error: ${e?.message ?? e}`, true);
      } finally {
        btnSave.disabled = false;
      }
    });

    for (const btnDelete of deleteBtns) {
      btnDelete.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = confirm('Delete this note permanently?');
        if (!ok) return;
        btnDelete.disabled = true;
        setStatus('Deleting…');
        try {
          const resp = await fetch(`/api/notes/${encodeURIComponent(item.id)}`, {
            method: 'DELETE'
          });
          if (!resp.ok) {
            const msg = await safeJson(resp);
            throw new Error(msg?.error || `Delete failed (${resp.status})`);
          }
          setStatus('Deleted');
          await refreshResults(qEl.value);
        } catch (e) {
          setStatus(`Delete error: ${e?.message ?? e}`, true);
          btnDelete.disabled = false;
        }
      });
    }

    btnRemove?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = confirm('Remove this note and stop processing?');
      if (!ok) return;
      btnRemove.disabled = true;
      setStatus('Removing…');
      try {
        const resp = await fetch(`/api/notes/${encodeURIComponent(item.id)}`, {
          method: 'DELETE'
        });
        if (!resp.ok) {
          const msg = await safeJson(resp);
          throw new Error(msg?.error || `Remove failed (${resp.status})`);
        }
        setStatus('Removed');
        await refreshResults(qEl.value);
      } catch (e) {
        setStatus(`Remove error: ${e?.message ?? e}`, true);
        btnRemove.disabled = false;
      }
    });

    for (const b of dlAudioBtns) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = `/api/notes/${encodeURIComponent(item.id)}/audio`;
        a.download = `${sanitizeFilename((item.display_title || item.title || 'recording').toString()) || 'recording'}.webm`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    }

    for (const btnReprocess of reprocessBtns) {
      btnReprocess.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = confirm(
          'Re-run transcription on the saved audio? The transcript, word timing, and detected language will refresh. This may take a minute.'
        );
        if (!ok) return;
        btnReprocess.disabled = true;
        setStatus('Reprocessing note…');
        try {
          const nid = (item.id ?? '').toString();
          procTimerByNoteId.delete(nid);
          const resp = await fetch(`/api/notes/${encodeURIComponent(nid)}/retry`, { method: 'POST' });
          const j = await safeJson(resp);
          if (!resp.ok) throw new Error(j?.error || `Reprocess failed (${resp.status})`);
          setStatus('Reprocessing…');
          await refreshResults(qEl.value);
        } catch (err) {
          setStatus(`Reprocess error: ${err?.message ?? err}`, true);
        } finally {
          btnReprocess.disabled = false;
        }
      });
    }

    const btnChangeLang = note.querySelector(`button[data-change-lang="${CSS.escape(String(item.id))}"]`);
    if (btnChangeLang) {
      btnChangeLang.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllActionMenus();
        if (btnActionsToggle) btnActionsToggle.textContent = '▼';
        const nid = (item.id ?? '').toString();
        const cur = (item.language ?? '').toString().trim();
        openChangeLanguageDialog({ currentLang: cur }, async ({ lang }) => {
          setStatus('Updating language…');
          try {
            const load = await fetch(`/api/notes/${encodeURIComponent(nid)}`);
            const full = await safeJson(load);
            if (!load.ok) throw new Error(full?.error || `Load failed (${load.status})`);
            const patch = await fetch(`/api/notes/${encodeURIComponent(nid)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                display_title: (full?.display_title ?? full?.title ?? item.display_title ?? item.title ?? '').toString(),
                body: (full?.body ?? item.body ?? '').toString(),
                language: lang,
                stt_provider: 'whisper'
              })
            });
            const pj = await safeJson(patch);
            if (!patch.ok) throw new Error(pj?.error || `Update failed (${patch.status})`);
            procTimerByNoteId.delete(nid);
            setStatus('Re-transcribing with new language…');
            const retry = await fetch(`/api/notes/${encodeURIComponent(nid)}/retry`, { method: 'POST' });
            const rj = await safeJson(retry);
            if (!retry.ok) throw new Error(rj?.error || `Reprocess failed (${retry.status})`);
            await refreshResults(qEl.value);
            setStatus('Reprocessing…');
          } catch (err) {
            setStatus(`Change language error: ${err?.message ?? err}`, true);
          }
        });
      });
    }

    for (const b of dlTextBtns) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = (item.body ?? '').toString();
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sanitizeFilename((item.display_title || item.title || 'transcript').toString()) || 'transcript'}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    }

    resultsEl.appendChild(note);
  }
  vvRenderMs = performance.now() - renderT0;

  requestAnimationFrame(() => {
    resultsEl.scrollTop = prevScroll;
  });

  syncProcessingNotesPoll(items);
  if (!isSearch) setStatus('Ready');

  // Perf breadcrumbs (check DevTools console): fetch vs render cost.
  try {
    if (!isSearch) {
      const totalMs = performance.now() - vvT0;
      console.debug('[voiceVault] saved-notes refresh', {
        count: items.length,
        fetch_ms: Math.round(vvFetchMs),
        render_ms: Math.round(vvRenderMs),
        total_ms: Math.round(totalMs)
      });
    }
  } catch {
    // ignore
  }
}

// Removed: Quick answer button + handler.

function renderAnswerHtmlWithCitations(answer, clips) {
  const safe = escapeHtml((answer ?? '').toString());
  // Replace [n] with clickable citation links if n is within clip range.
  const max = Array.isArray(clips) ? clips.length : 0;
  const html = safe.replace(/\[(\d{1,3})\]/g, (_m, nStr) => {
    const n = Number(nStr);
    if (!Number.isFinite(n) || n < 1 || n > max) return `[${nStr}]`;
    return `<a class="cite" href="#" data-cite="${n}">[${n}]</a>`;
  });
  return `
    <div class="answerTitle">Answer</div>
    <div class="answerMeta">Click citations like [1] to play the clip.</div>
    <div>${html}</div>
  `.trim();
}

function wireCitationClicks(rootEl, clips) {
  rootEl.querySelectorAll('a.cite[data-cite]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const n = Number(a.getAttribute('data-cite') || '0');
      const c = clips?.[n - 1];
      if (!c) return;
      const noteId = (c.note_id ?? '').toString();
      const start = Number(c.start);
      const end = Number(c.end);
      if (!noteId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
      playClipFromNote(noteId, start, end);
    });
  });
}

// Removed: Quick answer render box.

function playClipFromNote(noteId, start, end) {
  // Use (or create) a hidden global player so answer playback doesn't depend on which note is expanded.
  let audio = document.getElementById('globalAnswerAudio');
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'globalAnswerAudio';
    audio.controls = true;
    audio.className = 'audio';
    audio.hidden = true;
    // Place it near the top of the search card.
    answerWrapEl?.insertAdjacentElement?.('afterend', audio);
  }
  const wantSrc = `/api/notes/${encodeURIComponent(noteId)}/audio`;
  if (audio.src !== new URL(wantSrc, window.location.origin).toString()) {
    audio.src = wantSrc;
    try {
      audio.load();
    } catch {
      // ignore
    }
  }
  // Show controls while playing a clip.
  audio.hidden = false;
  playAudioRange(audio, start, end, { loop: loopSegments, rate: playbackRate });
}

async function loadNoteSegmentsIntoUi(noteId, noteEl, { highlight = null, autoPlayMatch = false } = {}) {
  const detailsEl = noteEl?.querySelector?.('.noteDetails');
  const bodyEl = noteEl?.querySelector?.('.noteBody');
  const audioEl = noteEl?.querySelector?.('audio');
  if (!detailsEl || !bodyEl || !audioEl) return;
  if (detailsEl.hidden) return; // only load when expanded

  // Avoid re-fetching if already loaded once.
  if (noteEl.dataset?.segmentsLoaded === '1') return;

  const resp = await fetch(`/api/notes/${encodeURIComponent(noteId)}`);
  if (!resp.ok) return;
  const data = await resp.json();
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  if (!segments.length) return;
  noteEl.dataset.segmentsLoaded = '1';

  const headerText = extractUploadedFilenameHeader(data);

  try {
    const metaEl = noteEl.querySelector('.noteFileMeta');
    if (metaEl) {
      const durationMs = Number(data?.duration_ms ?? 0) || 0;
      const parts = [];
      if (durationMs > 0) parts.push(formatMs(durationMs));
      const langShown = formatNoteLanguageMeta((data?.language ?? '').toString());
      if (langShown) parts.push(langShown);
      metaEl.textContent = parts.length ? parts.join(' · ') : '';
    }
  } catch {
    // ignore
  }

  const displayTitleRaw = (data?.display_title ?? '').toString().trim();
  const displayTitleEsc = displayTitleRaw ? escapeHtml(displayTitleRaw) : '';
  const titleBodySepHtml = displayTitleEsc
    ? `<div class="noteDisplayTitleBlock"><span class="noteDisplayTitleText">${displayTitleEsc}</span><span class="noteDisplayTitleActions"><button class="btn vvIconBtn" data-dl-text="${escapeHtml(
        String(noteId)
      )}" type="button" aria-label="Download transcript" title="Download transcript">${VV_ICON_SVG.doc}</button><button class="btn vvIconBtn" data-edit="${escapeHtml(
        String(noteId)
      )}" type="button" aria-label="Edit note" title="Edit">${VV_ICON_SVG.edit}</button></span></div><hr class="noteTitleBodyDivider" />`
    : '';

  // Replace transcript with clickable timestamped segments.
  bodyEl.innerHTML = titleBodySepHtml + renderSegmentsHtml(segments, { highlight, headerText });

  // Delegate clicks to Play buttons (text is not clickable).
  bodyEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const playBtn = target.closest?.('button[data-seg-play]');
    if (!playBtn) return;
    e.preventDefault();
    e.stopPropagation();
    closeAllActionMenus();

    const start = Number(playBtn.getAttribute('data-seg-start') || '0');
    const end = Number(playBtn.getAttribute('data-seg-end') || '0');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    const setSegBtn = (btnEl, mode) => {
      if (!(btnEl instanceof HTMLButtonElement)) return;
      if (mode === 'stop') {
        btnEl.innerHTML = VV_ICON_SVG.stop;
        btnEl.setAttribute('aria-label', 'Stop segment');
        btnEl.setAttribute('title', 'Stop');
      } else {
        const tt = `Play ${formatClock(start)}–${formatClock(end)}`;
        btnEl.innerHTML = VV_ICON_SVG.playSegment;
        btnEl.setAttribute('aria-label', 'Play segment');
        btnEl.setAttribute('title', tt);
      }
    };

    const wantSrc = `/api/notes/${encodeURIComponent(noteId)}/audio`;
    if (audioEl.src !== new URL(wantSrc, window.location.origin).toString()) {
      audioEl.src = wantSrc;
      try {
        audioEl.load();
      } catch {
        // ignore
      }
    }

    // Toggle off if this segment is already playing.
    const activeBtn = audioEl.__vvActiveSegBtn;
    const activeStart = Number(audioEl.__vvLastSegStart);
    const activeEnd = Number(audioEl.__vvLastSegEnd);
    const isActive = activeBtn === playBtn && Number.isFinite(activeStart) && Number.isFinite(activeEnd) && Math.abs(activeStart - start) < 0.001 && Math.abs(activeEnd - end) < 0.001;
    const isPlaying = !audioEl.paused && !audioEl.ended;
    if (isActive && isPlaying) {
      try {
        if (audioEl.__vvRangeCleanup) audioEl.__vvRangeCleanup();
        audioEl.pause();
        audioEl.currentTime = 0;
      } catch {
        // ignore
      }
      setSegBtn(playBtn, 'play');
      try {
        const loopBtn = noteEl?.querySelector?.(`button[data-loop="${CSS.escape(String(noteId))}"]`);
        if (loopBtn) loopBtn.hidden = true;
      } catch {
        // ignore
      }
      try {
        audioEl.__vvActiveSegBtn = null;
      } catch {
        // ignore
      }
      return;
    }

    // Reset any previously active segment button.
    if (activeBtn && activeBtn instanceof HTMLButtonElement && activeBtn !== playBtn) {
      try {
        activeBtn.innerHTML = VV_ICON_SVG.play;
        activeBtn.setAttribute('aria-label', 'Play segment');
      } catch {
        // ignore
      }
    }
    setSegBtn(playBtn, 'stop');
    try {
      audioEl.__vvActiveSegBtn = playBtn;
    } catch {
      // ignore
    }
    try {
      const loopBtn = noteEl?.querySelector?.(`button[data-loop="${CSS.escape(String(noteId))}"]`);
      if (loopBtn) loopBtn.hidden = false;
    } catch {
      // ignore
    }

    // Highlight words in the clicked segment while playing (if available).
    const rowEl = playBtn.closest?.('.segRow');
    try {
      audioEl.__vvLastSegStart = start;
      audioEl.__vvLastSegEnd = end;
    } catch {
      // ignore
    }
    playAudioRange(audioEl, start, end, { loop: loopSegments, rate: playbackRate });
    startWordHighlight(audioEl, rowEl);

    // Ensure button reverts when the range playback cleans up (end of segment or interruption).
    const revert = () => {
      try {
        if (audioEl.__vvActiveSegBtn === playBtn) {
          setSegBtn(playBtn, 'play');
          audioEl.__vvActiveSegBtn = null;
        }
      } catch {
        // ignore
      }
      try {
        const loopBtn = noteEl?.querySelector?.(`button[data-loop="${CSS.escape(String(noteId))}"]`);
        if (loopBtn) loopBtn.hidden = true;
      } catch {
        // ignore
      }
    };
    // playAudioRange sets __vvRangeCleanup asynchronously inside its `run`; wrap it after the call.
    setTimeout(() => {
      try {
        const curCleanup = audioEl.__vvRangeCleanup;
        if (!curCleanup || curCleanup.__vvWrappedForSegUi) return;
        const wrapped = () => {
          try {
            curCleanup();
          } finally {
            revert();
          }
        };
        wrapped.__vvWrappedForSegUi = true;
        audioEl.__vvRangeCleanup = wrapped;
      } catch {
        // ignore
      }
    }, 0);

    if (rowEl) {
      requestAnimationFrame(() => {
        try {
          rowEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
          ensureElementFullyVisible(rowEl, 12);
        } catch {
          // ignore
        }
      });
    }
  });

  // If we have match segments, scroll the first one into view. (No auto-play.)
  const matchList = normalizeHighlightList(highlight);
  if (matchList.length) {
    const h = matchList[0];
    const matchEl = bodyEl.querySelector(
      `[data-seg-start="${CSS.escape(String(h.start))}"][data-seg-end="${CSS.escape(String(h.end))}"]`
    );
    matchEl?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }
}

function startWordHighlight(audioEl, segRowEl) {
  if (!audioEl || !segRowEl) return;
  const words = Array.from(segRowEl.querySelectorAll?.('.word[data-ws][data-we]') ?? []);
  // Still tint the whole segment row even when word-level spans don't exist.
  try {
    segRowEl.classList.add('playing');
  } catch {
    // ignore
  }
  if (words.length === 0) {
    const cleanup = () => {
      try {
        segRowEl.classList.remove('playing');
      } catch {
        // ignore
      }
    };
    // If a previous cleanup existed, run it first.
    if (audioEl.__vvWordCleanup) {
      try {
        audioEl.__vvWordCleanup();
      } catch {
        // ignore
      }
      audioEl.__vvWordCleanup = null;
    }
    audioEl.__vvWordCleanup = cleanup;
    audioEl.addEventListener('pause', cleanup, { once: true });
    audioEl.addEventListener('ended', cleanup, { once: true });
    return;
  }

  // Stop any previous highlighter on this audio element.
  if (audioEl.__vvWordCleanup) {
    try {
      audioEl.__vvWordCleanup();
    } catch {
      // ignore
    }
    audioEl.__vvWordCleanup = null;
  }

  const clear = () => {
    for (const w of words) w.classList.remove('on');
  };

  const tick = () => {
    const t = Number(audioEl.currentTime);
    if (!Number.isFinite(t)) return;
    for (const w of words) {
      const ws = Number(w.getAttribute('data-ws') || '0');
      const we = Number(w.getAttribute('data-we') || '0');
      const on = Number.isFinite(ws) && Number.isFinite(we) && t >= ws && t < we;
      w.classList.toggle('on', on);
    }
  };

  clear();
  const intervalId = setInterval(tick, 50);

  const cleanup = () => {
    try {
      clearInterval(intervalId);
    } catch {
      // ignore
    }
    clear();
    try {
      segRowEl.classList.remove('playing');
    } catch {
      // ignore
    }
  };
  audioEl.__vvWordCleanup = cleanup;

  audioEl.addEventListener(
    'pause',
    () => {
      cleanup();
    },
    { once: true }
  );
}

function startSegRowFollowAll(audioEl, containerEl) {
  if (!audioEl || !containerEl) return;

  // Stop any previous row-highlighter on this audio element.
  if (audioEl.__vvSegRowCleanup) {
    try {
      audioEl.__vvSegRowCleanup();
    } catch {
      // ignore
    }
    audioEl.__vvSegRowCleanup = null;
  }

  const rows = Array.from(containerEl.querySelectorAll?.('.segRow[data-seg-start][data-seg-end]') ?? []);
  if (rows.length === 0) return;

  let lastRow = null;
  const clear = () => {
    if (lastRow) lastRow.classList.remove('playing');
    lastRow = null;
  };

  const tick = () => {
    const t = Number(audioEl.currentTime);
    if (!Number.isFinite(t)) return;
    let active = null;
    for (const r of rows) {
      const s = Number(r.getAttribute('data-seg-start') || '0');
      const e = Number(r.getAttribute('data-seg-end') || '0');
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      if (t >= s && t < e) {
        active = r;
        break;
      }
    }
    if (active !== lastRow) {
      if (lastRow) lastRow.classList.remove('playing');
      if (active) active.classList.add('playing');
      lastRow = active;
    }
  };

  tick();
  const intervalId = setInterval(tick, 80);
  const cleanup = () => {
    try {
      clearInterval(intervalId);
    } catch {
      // ignore
    }
    clear();
  };
  audioEl.__vvSegRowCleanup = cleanup;
  audioEl.addEventListener('pause', cleanup, { once: true });
  audioEl.addEventListener('ended', cleanup, { once: true });
}

function startWordFollowAll(audioEl, containerEl) {
  if (!audioEl || !containerEl) return;
  const words = Array.from(containerEl.querySelectorAll?.('.word[data-ws][data-we]') ?? []);
  // Even without word spans, we can still highlight the active segment row by time.
  if (words.length === 0) {
    startSegRowFollowAll(audioEl, containerEl);
    return;
  }

  // Stop any previous highlighter on this audio element.
  if (audioEl.__vvWordCleanup) {
    try {
      audioEl.__vvWordCleanup();
    } catch {
      // ignore
    }
    audioEl.__vvWordCleanup = null;
  }

  const clear = () => {
    for (const w of words) w.classList.remove('on');
  };

  let lastScrolledAt = 0;
  let lastRow = null;
  const tick = () => {
    const t = Number(audioEl.currentTime);
    if (!Number.isFinite(t)) return;
    let active = null;
    for (const w of words) {
      const ws = Number(w.getAttribute('data-ws') || '0');
      const we = Number(w.getAttribute('data-we') || '0');
      const on = Number.isFinite(ws) && Number.isFinite(we) && t >= ws && t < we;
      w.classList.toggle('on', on);
      if (on) active = w;
    }
    try {
      const row = active ? active.closest?.('.segRow') : null;
      if (row !== lastRow) {
        if (lastRow) lastRow.classList.remove('playing');
        if (row) row.classList.add('playing');
        lastRow = row;
      }
    } catch {
      // ignore
    }
    // Scroll occasionally so the user can follow.
    if (active && Date.now() - lastScrolledAt > 800) {
      lastScrolledAt = Date.now();
      try {
        active.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      } catch {
        // ignore
      }
    }
  };

  clear();
  const intervalId = setInterval(tick, 60);
  const cleanup = () => {
    try {
      clearInterval(intervalId);
    } catch {
      // ignore
    }
    clear();
    try {
      if (lastRow) lastRow.classList.remove('playing');
      lastRow = null;
    } catch {
      // ignore
    }
  };
  audioEl.__vvWordCleanup = cleanup;

  audioEl.addEventListener('pause', cleanup, { once: true });
}

function renderSegmentsHtml(segments, { highlight = null, headerText = '' } = {}) {
  const highlightList = normalizeHighlightList(highlight);
  const safe = [];

  if (headerText) {
    safe.push(`
      <div class="segRow segHeader">
        <span class="segHeaderLabel">File</span>
        <span class="segHeaderText">${escapeHtml(headerText)}</span>
      </div>
    `.trim());
  }

  for (const s of segments) {
    const start = Number(s?.start);
    const end = Number(s?.end);
    const text = (s?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    const isMatch = highlightList.some(
      (h) => Math.abs(Number(h.start) - start) < 0.001 && Math.abs(Number(h.end) - end) < 0.001
    );

    safe.push(`
      <div class="segRow${isMatch ? ' match' : ''}" data-seg-start="${escapeHtml(
      String(start)
    )}" data-seg-end="${escapeHtml(String(end))}">
        <button class="btn vvIconBtn segPlay" type="button" data-seg-play="1" data-seg-start="${escapeHtml(
          String(start)
        )}" data-seg-end="${escapeHtml(String(end))}" aria-label="Play segment" title="Play ${escapeHtml(
      `${formatClock(start)}–${formatClock(end)}`
    )}">${VV_ICON_SVG.playSegment}</button>
        <span class="segTime">${escapeHtml(`${formatClock(start)}–${formatClock(end)}`)}</span>
        <span class="segText">${escapeHtml(text)}</span>
      </div>
    `.trim());
  }
  return safe.join('\n');
}

function normalizeHighlightList(highlight) {
  if (!highlight) return [];
  if (Array.isArray(highlight)) {
    return highlight
      .map((h) => ({
        start: Number(h?.start),
        end: Number(h?.end)
      }))
      .filter((h) => Number.isFinite(h.start) && Number.isFinite(h.end) && h.end > h.start);
  }
  const start = Number(highlight?.start);
  const end = Number(highlight?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return [{ start, end }];
}

function normalizeMatchSegments(matches, { limit = 12 } = {}) {
  const out = [];
  const pushOne = (m) => {
    const start = Number(m?.start);
    const end = Number(m?.end);
    const text = (m?.text ?? '').toString().trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) return;
    out.push({ start, end, text });
  };
  if (Array.isArray(matches)) {
    for (const m of matches) {
      pushOne(m);
      if (out.length >= limit) break;
    }
  } else if (matches) {
    pushOne(matches);
  }
  return out;
}

function highlightTranscriptHtml(rawText, matchSegments, { mode = 'search' } = {}) {
  const raw = (rawText ?? '').toString();
  const segs = Array.isArray(matchSegments) ? matchSegments : [];
  if (!raw || segs.length === 0) return escapeHtml(raw);

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ranges = [];
  for (const s of segs) {
    const needle = (s?.text ?? '').toString().trim();
    if (!needle) continue;
    // Best-effort: find a match allowing flexible whitespace differences (\n vs space).
    // This avoids the common mismatch where semantic retrieval normalizes line breaks.
    const pattern = escapeRegExp(needle).replace(/\s+/g, '\\s+');
    let m = null;
    try {
      m = new RegExp(pattern, 'i').exec(raw);
    } catch {
      m = null;
    }
    if (!m || typeof m.index !== 'number') continue;
    const i0 = m.index;
    const i1 = m.index + (m[0] ? m[0].length : needle.length);
    const overlaps = ranges.some((r) => !(i1 <= r.i0 || i0 >= r.i1));
    if (overlaps) continue;
    ranges.push({ i0, i1, seg: s });
  }
  if (ranges.length === 0) return escapeHtml(raw);
  ranges.sort((a, b) => a.i0 - b.i0);

  const out = [];
  let cur = 0;
  for (const r of ranges) {
    if (r.i0 > cur) out.push(escapeHtml(raw.slice(cur, r.i0)));
    const cls = mode === 'playback' ? 'vvSearchHit playing' : 'vvSearchHit search';
    out.push(
      `<span class="${cls}" data-seg-start="${escapeHtml(String(r.seg.start))}" data-seg-end="${escapeHtml(
        String(r.seg.end)
      )}" title="Play matched segment">${escapeHtml(raw.slice(r.i0, r.i1))}</span>`
    );
    cur = r.i1;
  }
  if (cur < raw.length) out.push(escapeHtml(raw.slice(cur)));
  return out.join('');
}

function renderWordsHtmlFromSegments(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const words = [];
  for (const s of segs) {
    const ws = Array.isArray(s?.words) ? s.words : [];
    for (const w of ws) {
      const start = Number(w?.start);
      const end = Number(w?.end);
      const word = (w?.word ?? '').toString();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !word) continue;
      words.push({ start, end, word });
      if (words.length >= 60_000) break;
    }
    if (words.length >= 60_000) break;
  }
  if (words.length === 0) return '';
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  return words
    .map(
      (w) =>
        `<span class="word" data-ws="${escapeHtml(String(w.start))}" data-we="${escapeHtml(
          String(w.end)
        )}">${escapeHtml(w.word)}</span>`
    )
    .join('');
}

async function ensureNoteWordSpans(noteId, noteEl) {
  try {
    if (noteEl?.dataset?.wordsLoaded === '1') return true;
  } catch {
    // ignore
  }
  const detailsEl = noteEl?.querySelector?.('.noteDetails');
  const bodyEl = noteEl?.querySelector?.('.noteBody');
  if (!detailsEl || !bodyEl || detailsEl.hidden) return false;

  const resp = await fetch(`/api/notes/${encodeURIComponent(noteId)}`);
  if (!resp.ok) return false;
  const data = await resp.json();
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  const wordsHtml = renderWordsHtmlFromSegments(segments);
  if (!wordsHtml) return false;

  const displayTitleRaw = (data?.display_title ?? '').toString().trim();
  const displayTitleEsc = displayTitleRaw ? escapeHtml(displayTitleRaw) : '';
  const titleBodySepHtml = displayTitleEsc
    ? `<div class="noteDisplayTitleBlock"><span class="noteDisplayTitleText">${displayTitleEsc}</span></div><hr class="noteTitleBodyDivider" />`
    : '';

  bodyEl.innerHTML = titleBodySepHtml + wordsHtml;
  try {
    noteEl.dataset.wordsLoaded = '1';
  } catch {
    // ignore
  }
  return true;
}

function firstLineLooksLikeUploadedSourceFilename(line) {
  const s = (line ?? '').toString().trim();
  if (!s || s.length > 200) return false;

  // Natural-language transcripts often contain spaces; do not treat "has whitespace" as a filename signal.
  const letterish = s.replace(/[\s\d\p{M}\p{P}\p{S}]/gu, '');
  if (letterish.length) {
    let nonLatin = 0;
    for (const ch of letterish) {
      if (!/^[\p{Script=Latin}]$/u.test(ch)) nonLatin += 1;
    }
    if (nonLatin / letterish.length > 0.12) return false;
  }

  if (/\.[a-z0-9]{1,8}$/i.test(s)) return true;
  if (/^Upload_\d{4}-\d{2}-\d{2}_/i.test(s)) return true;
  if (/^Recording_\d{4}-\d{2}-\d{2}_/i.test(s)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9._\-]{0,180}\.[A-Za-z0-9]{1,8}$/.test(s);
}

function extractUploadedFilenameHeader(noteJson) {
  const headline = (noteJson?.display_title ?? noteJson?.title ?? '').toString().trim();
  const body = (noteJson?.body ?? '').toString();
  const firstLine = (body.split('\n')[0] ?? '').toString().trim();
  if (!firstLine) return '';

  // Heuristic: if we prefixed the transcript with source_filename, it will be the first line.
  // Only show it when it looks like a filename and the note title is an Upload_*.
  if (headline.startsWith('Upload_') && firstLineLooksLikeUploadedSourceFilename(firstLine)) return firstLine;
  return '';
}

function playAudioRange(audioEl, startSec, endSec, { loop = false, rate = null } = {}) {
  if (!audioEl) return;
  const src = audioEl.src || '';
  if (!src) return;

  // Cancel any previous range playback handler.
  if (audioEl.__vvRangeCleanup) {
    try {
      audioEl.__vvRangeCleanup();
    } catch {
      // ignore
    }
    audioEl.__vvRangeCleanup = null;
  }

  audioEl.hidden = false;
  try {
    audioEl.playbackRate = Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : playbackRate || 1;
  } catch {
    // ignore
  }
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.max(0, Number(endSec) || 0);
  if (!(end > start)) return;

  // Some formats (notably MP3) often require waiting for metadata before seeking works.
  const run = async () => {
    // Pause before we do anything.
    try {
      audioEl.pause();
    } catch {
      // ignore
    }

    // Ensure loading begins (important right after setting src).
    try {
      if (audioEl.readyState === 0) audioEl.load();
    } catch {
      // ignore
    }

    await waitForMetadata(audioEl, 2500);

    // Seek, then play.
    try {
      audioEl.currentTime = start;
    } catch {
      // ignore
    }
    await waitForSeekTo(audioEl, start, 2500);

    // Stop/loop at end using a short polling loop (more reliable than timeupdate alone).
    let stopped = false;
    const tickMs = 60;
    const intervalId = setInterval(() => {
      if (stopped) return;
      const t = Number(audioEl.currentTime);
      if (!Number.isFinite(t)) return;
      if (t >= end - 0.02) {
        if (loop) {
          try {
            audioEl.currentTime = start;
          } catch {
            // ignore
          }
          audioEl
            .play()
            .then(() => {
              // ok
            })
            .catch(() => {
              // ignore
            });
        } else {
          stopped = true;
          try {
            audioEl.pause();
          } catch {
            // ignore
          }
          try {
            clearInterval(intervalId);
          } catch {
            // ignore
          }
        }
      }
    }, tickMs);

    const cleanup = () => {
      stopped = true;
      try {
        clearInterval(intervalId);
      } catch {
        // ignore
      }
    };
    audioEl.__vvRangeCleanup = cleanup;

    audioEl
      .play()
      .then(() => {
        // ok
      })
      .catch(() => {
        // ignore autoplay restrictions
      });
  };

  run().catch(() => {
    // ignore
  });
}

function formatClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  if (hh > 0) return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${String(mm).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function waitForMetadata(audioEl, timeoutMs) {
  if (!audioEl) return Promise.resolve();
  if (audioEl.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        audioEl.removeEventListener('loadedmetadata', finish);
        audioEl.removeEventListener('canplay', finish);
        audioEl.removeEventListener('error', finish);
      } catch {
        // ignore
      }
      resolve();
    };
    audioEl.addEventListener('loadedmetadata', finish, { once: true });
    audioEl.addEventListener('canplay', finish, { once: true });
    audioEl.addEventListener('error', finish, { once: true });
    setTimeout(finish, Math.max(0, Number(timeoutMs) || 0));
  });
}

function waitForSeek(audioEl, timeoutMs) {
  if (!audioEl) return Promise.resolve();
  // If browser says it isn't seeking, proceed.
  if (!audioEl.seeking) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        audioEl.removeEventListener('seeked', finish);
        audioEl.removeEventListener('error', finish);
      } catch {
        // ignore
      }
      resolve();
    };
    audioEl.addEventListener('seeked', finish, { once: true });
    audioEl.addEventListener('error', finish, { once: true });
    setTimeout(finish, Math.max(0, Number(timeoutMs) || 0));
  });
}

function waitForSeekTo(audioEl, targetSec, timeoutMs) {
  if (!audioEl) return Promise.resolve();
  const target = Math.max(0, Number(targetSec) || 0);
  const tol = 0.25; // seconds
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        audioEl.removeEventListener('seeked', onSeeked);
        audioEl.removeEventListener('error', finish);
      } catch {
        // ignore
      }
      resolve();
    };

    const onSeeked = () => {
      finish();
    };

    audioEl.addEventListener('seeked', onSeeked);
    audioEl.addEventListener('error', finish, { once: true });

    const timer = setInterval(() => {
      const t = Number(audioEl.currentTime);
      if (Number.isFinite(t) && Math.abs(t - target) <= tol) {
        try {
          clearInterval(timer);
        } catch {
          // ignore
        }
        finish();
        return;
      }
      if (Date.now() - startedAt > Math.max(0, Number(timeoutMs) || 0)) {
        try {
          clearInterval(timer);
        } catch {
          // ignore
        }
        finish();
      }
    }, 50);
  });
}

function updateScrollHint(transcriptBox, hintEl) {
  if (!transcriptBox || !hintEl) return;
  const overflow = transcriptBox.scrollHeight > transcriptBox.clientHeight + 4;
  const nearBottom =
    transcriptBox.scrollTop + transcriptBox.clientHeight >= transcriptBox.scrollHeight - 6;
  const last = Number(transcriptBox.dataset.lastScrollTop ?? '0') || 0;
  const current = transcriptBox.scrollTop;
  const direction = current > last ? 'down' : current < last ? 'up' : 'none';
  transcriptBox.dataset.lastScrollTop = String(current);

  // Show if there's more below, and user is scrolling down.
  // Hide when scrolling up or once at the bottom.
  hintEl.hidden = !overflow || nearBottom || direction === 'up';
}

function startProcessingTimers() {
  setInterval(() => {
    const els = document.querySelectorAll('.noteProcessingTime[data-processing-since]');
    const now = Date.now();
    for (const el of els) {
      const id = (el.getAttribute('data-note-id') ?? '').toString();
      const tm = id ? procTimerByNoteId.get(id) : null;

      if (tm?.paused) {
        if (typeof tm.frozenChipText === 'string') {
          el.textContent = tm.frozenChipText;
        } else {
          let pct = NaN;
          if (typeof tm.frozenPercentLeft === 'number') {
            pct = tm.frozenPercentLeft;
          } else if (typeof tm.frozenRemainingMs === 'number') {
            const est = Number(tm.estimatedMs) || Number(el.getAttribute('data-estimated-total-ms') ?? '') || DEFAULT_PROCESSING_ESTIMATE_MS;
            pct = Math.max(1, Math.min(100, Math.round((100 * Math.max(0, tm.frozenRemainingMs)) / Math.max(1, est))));
          } else if (typeof tm.frozenMs === 'number') {
            const cap =
              Number(el.getAttribute('data-estimated-total-ms') ?? '') || DEFAULT_PROCESSING_ESTIMATE_MS;
            pct = Math.max(1, Math.min(100, Math.round((100 * Math.max(0, cap - tm.frozenMs)) / Math.max(1, cap))));
          }
          const stage = (tm.frozenCoarseStage ?? el.getAttribute('data-processing-stage') ?? '').toString().trim();
          el.textContent = formatProcessingProgressChipText({
            pct,
            pastBudget: !!tm.frozenPastBudget,
            coarseStage: stage,
            retranscribeFallback: (el.getAttribute('data-retranscribe-fallback') ?? '') === '1'
          });
        }
        continue;
      }

      const iso = el.getAttribute('data-processing-since') || '';
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) continue;
      const elapsed = Math.max(0, now - t);
      const prog = processingProgressFromElement(el, elapsed);
      el.textContent = formatProcessingProgressChipText({
        pct: prog.pct,
        pastBudget: prog.pastBudget,
        coarseStage: prog.coarseStage,
        retranscribeFallback: prog.retranscribeFallback
      });
    }
  }, 1000);
}

function startLiveTranscript(state) {
  if (state.liveTxTimerId) clearInterval(state.liveTxTimerId);
  if (!liveTranscriptEl) return;
  if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
  liveTranscriptEl.value = '';
  if (liveTxStatusEl) liveTxStatusEl.hidden = false;
  setLiveTxPhaseLabel('Live Transcription');
  syncLiveTxScrollRowVisibility();

  state.liveTxTimerId = setInterval(() => {
    if (!state.isRecording) return;
    if (state.liveTxInFlight) return;
    if (!state.chunks || state.chunks.length < 2) return;

    const blob = buildSlidingWebmBlobForLiveStt(state, LIVE_TRANSCRIBE_MAX_WINDOW_MS);
    if (!blob || blob.size < LIVE_TRANSCRIBE_MIN_CHUNK_BYTES) return;

    state.liveTxInFlight = true;
    armLiveTxPreviewCountdown({
      duration_ms: audioDurationMsFromBytes(blob.size),
      audio_bytes: blob.size
    });
    const fd = new FormData();
    fd.append('language', (noteLanguageEl?.value ?? '').toString());
    fd.append('stt_provider', getNewNoteSttProvider());
    fd.append('audio', blob, guessFilename(blob.type));

    state.liveTranscribeTail = state.liveTranscribeTail.then(async () => {
      setLiveTxPhaseLabel('Live Transcription');
      try {
        const r = await fetch('/api/live-transcribe', { method: 'POST', body: fd });
        if (!r.ok) return;
        let data = await r.json();
        let t = vvFormatTranscript(data?.transcript ?? '').trim();
        const hint = (noteLanguageEl?.value ?? '').toString().trim();
        if (!t && hint) {
          const fd2 = new FormData();
          fd2.append('language', '');
          fd2.append('stt_provider', getNewNoteSttProvider());
          fd2.append('audio', blob, guessFilename(blob.type));
          try {
            const r2 = await fetch('/api/live-transcribe', { method: 'POST', body: fd2 });
            if (r2.ok) {
              data = await r2.json();
              t = vvFormatTranscript(data?.transcript ?? '').trim();
            }
          } catch {
            // ignore
          }
        }
        if (!liveTranscriptEl) return;
        if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
        if (t) {
          liveTranscriptEl.value = t;
          if (liveTxStatusEl && state.isRecording) liveTxStatusEl.hidden = true;
          syncLiveTxScrollRowVisibility();
        }
      } catch {
        // ignore
      } finally {
        clearLiveTxPreviewCountdown();
        state.liveTxInFlight = false;
      }
    });
  }, LIVE_TRANSCRIBE_INTERVAL_MS);
}

function stopLiveTranscript(state) {
  if (state?.liveTxTimerId) {
    clearInterval(state.liveTxTimerId);
    state.liveTxTimerId = null;
  }
  // Do not clear liveTxInFlight here — an in-flight fetch may still be running; its `finally` clears it.
  // Keep the last preview visible after stopping.
  if (state === note) {
    clearLiveTxPreviewCountdown();
    if (liveTxStatusEl) liveTxStatusEl.hidden = true;
    if (liveTranscriptEl && !state.liveTxStartedAfterLang) {
      liveTranscriptEl.value = '';
    }
    syncLiveTxScrollRowVisibility();
  }
}

function startLiveQueryTranscript(state) {
  if (state.liveTxTimerId) clearInterval(state.liveTxTimerId);
  if (!qEl) return;
  qEl.value = '';

  state.liveTxTimerId = setInterval(() => {
    if (!state.isRecording) return;
    if (state.liveTxInFlight) return;
    if (!state.chunks || state.chunks.length < 2) return;

    const blob = buildSlidingWebmBlobForLiveStt(state, LIVE_TRANSCRIBE_MAX_WINDOW_MS);
    if (!blob || blob.size < LIVE_TRANSCRIBE_MIN_CHUNK_BYTES) return;

    state.liveTxInFlight = true;
    const fd = new FormData();
    fd.append('language', ''); // always auto-detect for search
    fd.append('stt_provider', getNewNoteSttProvider());
    fd.append('audio', blob, guessFilename(blob.type));

    fetch('/api/live-transcribe', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const t = (data?.transcript ?? '').toString().trim();
        if (!qEl) return;
        if (t) qEl.value = t;
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        state.liveTxInFlight = false;
      });
  }, LIVE_TRANSCRIBE_INTERVAL_MS);
}

function stopLiveQueryTranscript(state) {
  // Reuse the same timer slot as note live transcript.
  if (state?.liveTxTimerId) {
    clearInterval(state.liveTxTimerId);
    state.liveTxTimerId = null;
  }
  if (state) state.liveTxInFlight = false;
}

async function transcribeFullPreview(opts = {}) {
  const restart = !!opts.restart;
  if (transcribeFullPreviewInFlight && !restart) {
    return transcribeFullPreviewInFlight;
  }
  if (fullPreviewAbortController) {
    try {
      fullPreviewAbortController.abort();
    } catch {
      // ignore
    }
    fullPreviewAbortController = null;
  }
  const prev = transcribeFullPreviewInFlight;
  if (prev) {
    try {
      await prev;
    } catch {
      // ignore
    }
    transcribeFullPreviewInFlight = null;
  }
  const ac = new AbortController();
  fullPreviewAbortController = ac;
  transcribeFullPreviewInFlight = transcribeFullPreviewImpl(ac.signal).finally(() => {
    transcribeFullPreviewInFlight = null;
    if (fullPreviewAbortController === ac) fullPreviewAbortController = null;
  });
  return transcribeFullPreviewInFlight;
}

async function transcribeFullPreviewImpl(signal) {
  if (!note.audioBlob) return;
  if (!liveTranscriptEl) return;

  lastFullPreviewBundle = null;
  noteFullPreviewGateOk = false;
  noteAllowManualSaveFinal = false;

  if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
  // UX: keep last live-chunk transcript visible until the full-file result returns (do not blank here).
  const priorLiveText = (liveTranscriptEl.value ?? '').toString();
  if (liveTxStatusEl) liveTxStatusEl.hidden = false;
  setLiveTxPhaseLabel('Full Transcription');
  syncLiveTxScrollRowVisibility();
  armLiveTxPreviewCountdown({
    duration_ms: Math.round(note.durationMs || 0),
    audio_bytes: Number(note.audioBlob?.size || 0) || 0
  });

  const fd = new FormData();
  const langHint =
    (noteLanguageEl?.value ?? '').toString().trim() || primaryLanguageCode(noteLastDetectedApiLang);
  fd.append('language', langHint);
  fd.append('stt_provider', getNewNoteSttProvider());
  fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));

  const failFullPreview = (msg, { serverDetail = '' } = {}) => {
    if (signal.aborted) return;
    const detail = (serverDetail ?? '').toString().trim();
    setStatus(detail ? `${msg} ${detail}` : msg, true);
    if (liveTxStatusEl) liveTxStatusEl.hidden = true;
    setLiveTxPhaseLabel('Full Transcription failed');
    noteFullPreviewGateOk = false;
    noteAllowManualSaveFinal = true;
    if (liveTranscriptEl) {
      liveTranscriptEl.readOnly = false;
    }
    setNewNoteTranscriptionStages({
      live: noteUsedMicForCurrentBlob ? 'done' : 'skipped',
      full: 'pending',
      showRow: true
    });
    syncLiveTxScrollRowVisibility();
    updateGenerateFullPreviewButtonVisibility();
    syncVisibility();
  };

  try {
    let resp;
    try {
      resp = await fetch('/api/transcribe', { method: 'POST', body: fd, signal });
    } catch (netErr) {
      if (netErr?.name === 'AbortError' || signal.aborted) return;
      failFullPreview(`Full preview failed (network): ${netErr?.message ?? netErr}`);
      return;
    }

    if (signal.aborted) return;

    if (!resp.ok) {
      let detail = '';
      try {
        const errBody = await safeJson(resp);
        detail = (errBody?.details ?? errBody?.error ?? '').toString().trim();
      } catch {
        // ignore
      }
      failFullPreview('Full preview failed — server returned an error.', { serverDetail: detail });
      return;
    }

    const data = await safeJson(resp);
    if (signal.aborted) return;
    if (!data || typeof data !== 'object') {
      failFullPreview('Full preview failed — empty or invalid response from server.');
      return;
    }

    const rawFromApi = (data?.transcript ?? '').toString();
    const segRaw = Array.isArray(data?.segments) ? data.segments : [];
    const segments = vvSanitizePreviewSegments(segRaw);
    const transcriptForBundle = rawFromApi.trim()
      ? rawFromApi
      : vvTranscriptFromSegments(segments.length ? segments : segRaw);
    const formatted = vvFormatTranscript(transcriptForBundle).trim();
    liveTranscriptEl.value = formatted || priorLiveText;

    if (!formatted || segments.length === 0) {
      lastFullPreviewBundle = null;
      noteFullPreviewGateOk = false;
      noteAllowManualSaveFinal = true;
      if (liveTxStatusEl) liveTxStatusEl.hidden = true;
      setLiveTxPhaseLabel('No transcript returned');
      if (liveTranscriptEl) liveTranscriptEl.readOnly = false;
      setNewNoteTranscriptionStages({
        live: noteUsedMicForCurrentBlob ? 'done' : 'skipped',
        full: 'pending',
        showRow: true
      });
      setStatus(
        'Full preview returned no usable text (check server Whisper / Python). You can type the transcript and Save.',
        true
      );
      updateGenerateFullPreviewButtonVisibility();
      syncVisibility();
    } else {
      lastFullPreviewBundle = {
        transcript: transcriptForBundle,
        segments,
        detected_language: (data?.language ?? '').toString().trim(),
        language_hint: (noteLanguageEl?.value ?? '').toString().trim(),
        stt_provider: getNewNoteSttProvider(),
        duration_ms: Math.round(note.durationMs || 0),
        audio_bytes: Number(note.audioBlob?.size || 0) || 0
      };
      noteFullPreviewGateOk = true;
      noteAllowManualSaveFinal = false;
      if (liveTxStatusEl) liveTxStatusEl.hidden = true;
      setLiveTxPhaseLabel('Ready');
      syncLiveTxScrollRowVisibility();
      if (liveTranscriptEl) liveTranscriptEl.readOnly = false;
      setNewNoteTranscriptionStages({
        live: noteUsedMicForCurrentBlob ? 'done' : 'skipped',
        full: 'done',
        showRow: true
      });
      updateGenerateFullPreviewButtonVisibility();
      syncVisibility();
    }
  } finally {
    clearLiveTxPreviewCountdown();
  }
}

async function refreshIngestionUi({ toggleList = false, forceShow = null } = {}) {
  try {
  if (
    !btnIngestPauseEl ||
    !btnIngestResumeEl ||
    !jobsListEl ||
    !jobsPausedPillEl ||
    !jobsSummaryEl ||
    !jobsFiltersEl ||
    !jobsStatusFilterEl ||
    !jobsMaxParallelEl ||
    !btnJobsApplyEl ||
    !jobsBackoffBaseSecEl ||
    !jobsBackoffMaxSecEl ||
    !btnJobsRetryAllEl ||
    !btnJobsUnlockNowEl
  ) {
    return;
  }

  let summary = null;
  try {
    const summaryResp = await fetch('/api/processes/summary');
    if (summaryResp.ok) summary = await summaryResp.json();
  } catch {
    summary = null;
  }

  let paused = false;
  if (summary) paused = !!summary?.paused;
  else {
    try {
      const ir = await fetch('/api/ingestion');
      if (ir.ok) {
        const ij = await ir.json();
        paused = !!ij?.paused;
      }
    } catch {
      // ignore
    }
  }

  jobsPausedPillEl.hidden = !paused;
  btnIngestPauseEl.hidden = paused;
  btnIngestResumeEl.hidden = !paused;

  if (summary) {
    const maxParallel = Number(summary?.max_parallel ?? 1) || 1;
    if (!jobsMaxParallelEl.value) jobsMaxParallelEl.value = String(maxParallel);

    const jobs = summary?.jobs ?? {};
    const notes = summary?.notes ?? {};
    const delayed = Number(summary?.jobs_delayed_queued ?? 0) || 0;
    const lastUnlockAt = (summary?.jobs_last_stale_unlock_at ?? '').toString().trim();
    const lastUnlockCount = Number(summary?.jobs_last_stale_unlock_count ?? 0) || 0;
    const backoffBase = Number(summary?.backoff_base_sec ?? 5) || 5;
    const backoffMax = Number(summary?.backoff_max_sec ?? 300) || 300;
    if (!jobsBackoffBaseSecEl.value) jobsBackoffBaseSecEl.value = String(backoffBase);
    if (!jobsBackoffMaxSecEl.value) jobsBackoffMaxSecEl.value = String(backoffMax);
    jobsSummaryEl.innerHTML = `
    <span class="jobsKpi"><strong>Jobs</strong> queued ${escapeHtml(String(jobs.queued ?? 0))}</span>
    <span class="jobsKpi">delayed ${escapeHtml(String(delayed))}</span>
    <span class="jobsKpi">running ${escapeHtml(String(jobs.running ?? 0))}</span>
    <span class="jobsKpi">error ${escapeHtml(String(jobs.error ?? 0))}</span>
    <span class="jobsKpi">done ${escapeHtml(String(jobs.done ?? 0))}</span>
    <span class="jobsKpi">cancelled ${escapeHtml(String(jobs.cancelled ?? 0))}</span>
    <span class="jobsKpi"><strong>Notes</strong> processing ${escapeHtml(String(notes.processing ?? 0))}</span>
    <span class="jobsKpi">error ${escapeHtml(String(notes.error ?? 0))}</span>
    ${
      lastUnlockAt
        ? `<span class="jobsKpi">unlocked ${escapeHtml(String(lastUnlockCount))} • ${escapeHtml(lastUnlockAt.slice(11, 19))}</span>`
        : `<span class="jobsKpi">unlocked 0</span>`
    }
  `.trim();
  } else {
    jobsSummaryEl.innerHTML = `<span class="jobsKpi err">Summary unavailable (job list still loads if the jobs API responds)</span>`;
  }

  // Skip jobs list work only when the Processes panel is closed and we are not forcing a refresh.
  const processesPanelOpen = !!(processCardEl && !processCardEl.hidden);
  if (!processesPanelOpen && forceShow !== true) return;

  const nextHidden =
    forceShow === true ? false : forceShow === false ? true : toggleList ? !jobsListEl.hidden : jobsListEl.hidden;
  jobsListEl.hidden = nextHidden;

  if (!jobsListEl.hidden) {
    jobsSummaryEl.hidden = false;
    jobsFiltersEl.hidden = false;
    jobsStatusFilterEl.value = procStatusFilter;

    const url = new URL('/api/jobs', window.location.origin);
    url.searchParams.set('limit', '60');
    if (procStatusFilter) url.searchParams.set('status', procStatusFilter);
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      let hint = `${resp.status}`;
      try {
        const ej = await safeJson(resp);
        hint = `${resp.status}: ${escapeHtml(((ej?.error ?? ej?.details) ?? '').toString().slice(0, 200))}`;
      } catch {
        /* ignore */
      }
      jobsListEl.innerHTML = `<div class="jobItem err">Could not load jobs (${hint}).</div>`;
      return;
    }
    const data = await resp.json();
    const items = Array.isArray(data?.items) ? data.items : [];

    jobsListEl.innerHTML = items.length
      ? items
          .map((j) => {
            const st = (j?.status ?? '').toString();
            const jt = (j?.job_type ?? '').toString();
            const title = (j?.note_title ?? j?.note_id ?? '').toString();
            const err = (j?.last_error ?? '').toString().trim();
            const avail = (j?.available_at ?? '').toString().trim();
            const id = (j?.id ?? '').toString();
            const canCancel = st !== 'running';
            const retryIn =
              st === 'queued' && avail
                ? Math.max(0, Math.floor((Date.parse(avail) - Date.now()) / 1000))
                : null;
            return `
              <div class="jobItem">
                <div><strong>${escapeHtml(st)}</strong> • ${escapeHtml(jt)} • ${escapeHtml(title)}</div>
                <div class="jobMeta">
                  attempts ${escapeHtml(String(j?.attempts ?? 0))}/${escapeHtml(String(j?.max_attempts ?? 0))}
                  ${retryIn !== null && retryIn > 0 ? `• retry in ${escapeHtml(String(retryIn))}s` : ''}
                  ${err ? `• <span class="err">${escapeHtml(err.slice(0, 120))}</span>` : ''}
                </div>
                <div style="margin-top:6px; display:flex; gap:10px; flex-wrap:wrap">
                  <button class="btn" data-job-details="${escapeHtml(id)}" type="button">Details</button>
                  ${st === 'error' || st === 'done'
                    ? `<button class="btn" data-job-retry="${escapeHtml(id)}" type="button">Retry</button>`
                    : ''}
                  ${canCancel ? `<button class="btn vvIconBtn err" data-job-cancel="${escapeHtml(id)}" type="button" aria-label="Cancel job" title="Cancel">${VV_ICON_SVG.cancel}</button>` : ''}
                  ${
                    st !== 'running'
                      ? `<button class="btn vvIconBtn err" data-proc-delete-job="${escapeHtml(id)}" type="button" aria-label="Delete process" title="Remove this job and delete its note from the library (if the note still exists)">${VV_ICON_SVG.delete}</button>`
                      : ''
                  }
                </div>
              </div>
            `.trim();
          })
          .join('\n')
      : `<div class="jobItem">No jobs</div>`;

    jobsListEl.querySelectorAll('button[data-job-details]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = (b.getAttribute('data-job-details') ?? '').toString();
        if (!id) return;
        try {
          const url2 = new URL('/api/jobs', window.location.origin);
          url2.searchParams.set('limit', '200');
          const resp2 = await fetch(url2.toString());
          const data2 = await safeJson(resp2);
          const items2 = Array.isArray(data2?.items) ? data2.items : [];
          const j = items2.find((x) => (x?.id ?? '').toString() === id);
          if (!j) return setStatus('Job not found', true);
          showJobDetails(j);
        } catch {
          // ignore
        }
      });
    });

    jobsListEl.querySelectorAll('button[data-job-retry]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = (b.getAttribute('data-job-retry') ?? '').toString();
        if (!id) return;
        b.disabled = true;
        try {
          await fetch(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
          setStatus('Job re-queued');
          await refreshIngestionUi({ toggleList: false, forceShow: true });
        } catch {
          // ignore
        } finally {
          b.disabled = false;
        }
      });
    });

    jobsListEl.querySelectorAll('button[data-job-cancel]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const id = (b.getAttribute('data-job-cancel') ?? '').toString();
        if (!id) return;
        b.disabled = true;
        try {
          const resp2 = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
          const data2 = await safeJson(resp2);
          if (!resp2.ok) throw new Error(data2?.error || `Cancel failed (${resp2.status})`);
          setStatus('Process cancelled');
          await refreshIngestionUi({ toggleList: false, forceShow: true });
        } catch (err2) {
          setStatus(`Cancel error: ${err2?.message ?? err2}`, true);
        } finally {
          b.disabled = false;
        }
      });
    });

    jobsListEl.querySelectorAll('button[data-proc-delete-job]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        const jobId = (b.getAttribute('data-proc-delete-job') ?? '').toString().trim();
        if (!jobId) return;
        if (
          !confirm(
            'Delete this process and remove its note from your library? If the note was already deleted, only the job row is removed.'
          )
        ) {
          return;
        }
        b.disabled = true;
        try {
          let resp2 = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          if (resp2.status === 404) {
            resp2 = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
          }
          const data2 = await safeJson(resp2);
          if (!resp2.ok) throw new Error(data2?.error || `Remove failed (${resp2.status})`);
          try {
            b.closest('.jobItem')?.remove();
          } catch {
            // ignore
          }
          const nid = (data2?.note_id ?? '').toString().trim();
          if (nid && data2?.note_deleted) {
            if (newNotePendingProcessId === nid) hideNewNoteProcessingStatus();
            procTimerByNoteId.delete(nid);
            expandedNoteIds.delete(nid);
            expandedNoteIdsFromSearchMatch.delete(nid);
          }
          setStatus(data2?.note_deleted ? 'Note and process removed' : 'Process removed');
          await refreshIngestionUi({ toggleList: false, forceShow: true });
          if (nid && data2?.note_deleted) {
            await refreshResults((qEl?.value ?? '').toString()).catch(() => {
              // ignore
            });
          }
        } catch (err2) {
          setStatus(`Remove error: ${err2?.message ?? err2}`, true);
        } finally {
          b.disabled = false;
        }
      });
    });
  } else {
    jobsSummaryEl.hidden = true;
    jobsFiltersEl.hidden = true;
  }
  } finally {
    try {
      updateMainGridLayout({ prefer: 'auto' });
    } catch {
      // ignore
    }
  }
}

async function applyProcessingSettings() {
  if (!jobsStatusFilterEl || !jobsMaxParallelEl || !jobsBackoffBaseSecEl || !jobsBackoffMaxSecEl) return;
  procStatusFilter = (jobsStatusFilterEl.value ?? '').toString().trim();
  const n = Number.parseInt((jobsMaxParallelEl.value ?? '').toString(), 10);
  if (Number.isFinite(n) && n >= 1 && n <= 6) {
    try {
      await fetch('/api/processes/max-parallel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_parallel: n })
      });
    } catch {
      // ignore
    }
  }
  const base = Number.parseInt((jobsBackoffBaseSecEl.value ?? '').toString(), 10);
  const max = Number.parseInt((jobsBackoffMaxSecEl.value ?? '').toString(), 10);
  if (Number.isFinite(base) && Number.isFinite(max)) {
    try {
      await fetch('/api/processes/backoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_sec: base, max_sec: max })
      });
    } catch {
      // ignore
    }
  }
  await refreshIngestionUi({ toggleList: false, forceShow: true });
}

async function showJobDetails(j) {
  const st = (j?.status ?? '').toString();
  const jt = (j?.job_type ?? '').toString();
  const id = (j?.id ?? '').toString();
  const noteId = (j?.note_id ?? '').toString();
  const title = (j?.note_title ?? '').toString();
  const attempts = `${Number(j?.attempts ?? 0) || 0}/${Number(j?.max_attempts ?? 0) || 0}`;
  const lockedAt = (j?.locked_at ?? '').toString();
  const availableAt = (j?.available_at ?? '').toString();
  const createdAt = (j?.created_at ?? '').toString();
  const updatedAt = (j?.updated_at ?? '').toString();
  const err = (j?.last_error ?? '').toString();

  const lines = [
    `Status: ${st}`,
    `Type: ${jt}`,
    `Job id: ${id}`,
    `Note: ${title || '(no title)'} (${noteId})`,
    `Attempts: ${attempts}`,
    lockedAt ? `Locked at: ${lockedAt}` : `Locked at: (none)`,
    availableAt ? `Available at: ${availableAt}` : `Available at: (now)`,
    createdAt ? `Created: ${createdAt}` : '',
    updatedAt ? `Updated: ${updatedAt}` : '',
    err ? `\nLast error:\n${err}` : '\nLast error:\n(none)'
  ]
    .filter(Boolean)
    ;

  // Fetch and append event timeline (best effort).
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/events?limit=200`);
    const j2 = await safeJson(r);
    const items = Array.isArray(j2?.items) ? j2.items : [];
    if (items.length) {
      lines.push(`\nTimeline (newest first):`);
      for (const ev of items) {
        const ts = (ev?.created_at ?? '').toString();
        const type = (ev?.event_type ?? '').toString();
        const msg = (ev?.message ?? '').toString();
        let meta = (ev?.meta_json ?? '').toString().trim();
        if (meta && meta.length > 400) meta = meta.slice(0, 400) + '…';
        const one = [`- ${ts || '(time?)'} • ${type || 'event'}`, msg ? `  ${msg}` : '', meta ? `  meta: ${meta}` : '']
          .filter(Boolean)
          .join('\n');
        lines.push(one);
      }
    }
  } catch {
    // ignore
  }

  const msg = lines.join('\n');

  if (!jobDetailsOverlayEl || !jobDetailsPreEl || !btnJobDetailsCloseEl || !btnJobDetailsCopyEl) {
    // Fallback.
    alert(msg);
    return;
  }

  jobDetailsPreEl.textContent = msg;
  jobDetailsOverlayEl.hidden = false;

  const close = () => {
    jobDetailsOverlayEl.hidden = true;
  };
  btnJobDetailsCloseEl.onclick = (e) => {
    e.preventDefault();
    close();
  };
  jobDetailsOverlayEl.onclick = (e) => {
    if (e.target === jobDetailsOverlayEl) close();
  };
  btnJobDetailsCopyEl.onclick = async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(msg);
      setStatus('Copied job details');
    } catch {
      // Clipboard can fail in some contexts; fallback to prompt.
      try {
        window.prompt('Copy job details:', msg);
      } catch {
        // ignore
      }
    }
  };
}

function pollNoteUntilDone(id) {
  const started = Date.now();
  const timeoutMs = 45_000;
  const intervalMs = 1500;
  const nid = (id ?? '').toString().trim();

  const timer = setInterval(async () => {
    if (Date.now() - started > timeoutMs) {
      clearInterval(timer);
      return;
    }
    try {
      const resp = await fetch(`/api/notes/${encodeURIComponent(id)}`);
      if (!resp.ok) return;
      const n = await resp.json();
      const status = (n?.status ?? '').toString();
      if (status === 'ready' || status === 'error') {
        clearInterval(timer);
        if (nid && newNotePendingProcessId === nid) hideNewNoteProcessingStatus();
      }
      await refreshResults(qEl.value);
    } catch {
      // ignore transient errors
    }
  }, intervalMs);
}

function buildSearchTranscribeForm(audioBlob) {
  const fd = new FormData();
  fd.append('audio', audioBlob, guessFilename(audioBlob.type));
  fd.append('stt_provider', getNewNoteSttProvider());
  fd.append('language', '');
  return fd;
}

async function postTranscribeSearch(audioBlob) {
  const attemptFetch = () =>
    fetch('/api/transcribe', { method: 'POST', body: buildSearchTranscribeForm(audioBlob) });

  let resp = await attemptFetch();
  // Transient gateway timeouts while STT runs are common; retry once after a short wait.
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    await new Promise((r) => setTimeout(r, 900));
    resp = await attemptFetch();
  }

  if (!resp.ok) {
    const msg = await safeJson(resp);
    const detail = (msg?.details ?? msg?.error ?? '').toString().trim();
    const base = msg?.error || `Transcribe failed (${resp.status})`;
    const hint =
      resp.status === 502 || resp.status === 503 || resp.status === 504
        ? ' Server or proxy timed out—try a shorter clip, or ask the host to raise proxy_read_timeout for /api/transcribe.'
        : '';
    throw new Error(detail ? `${base}: ${detail}${hint}` : `${base}${hint}`);
  }
  return safeJson(resp);
}

async function runAudioSearch() {
  if (!query.audioBlob) {
    const typed = qEl.value.trim();
    if (!typed) return;
    setStatus(`Searching: "${typed}"`);
    await refreshResults(typed);
    return;
  }
  btnSearch.disabled = true;
  setStatus('Transcribing search…');

  try {
    const data = await postTranscribeSearch(query.audioBlob);
    const transcript = (data?.transcript ?? '').toString().trim();
    qEl.value = transcript;

    resetRecorder(query);
    previewQuery.hidden = true;
    previewQuery.src = '';

    setStatus(transcript ? `Searching: "${transcript}"` : 'Search transcript empty');
    await refreshResults(transcript);
    syncVisibility();
  } catch (err) {
    setStatus(`Search error: ${err?.message ?? err}`, true);
    btnSearch.disabled = false;
  }
}

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text ?? '';
  const t = (text ?? '').toString().trim().toLowerCase();
  const isReady = !isError && t === 'ready';
  const isBusy = !isError && t.startsWith('displaying saved notes');
  statusEl.className = `status${isError ? ' err' : isReady ? ' ok' : ''}${isBusy ? ' busy' : ''}`;
}

function pickMimeType() {
  // Force WebM for consistent server handling and predictable file sizes.
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  throw new Error('Your browser does not support audio/webm recording.');
}

function guessFilename(mime) {
  if (mime?.includes('webm')) return 'note.webm';
  return 'note.webm';
}

function escapeHtml(s) {
  return (s ?? '').toString().replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#039;';
      default:
        return ch;
    }
  });
}

function truncateNotePreviewPlain(raw, maxLen) {
  const n = Math.max(40, Number(maxLen) || 280);
  const t = (raw ?? '').toString().replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

function sanitizeFilename(name) {
  return (name ?? '')
    .toString()
    .trim()
    .replaceAll(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replaceAll(/\s+/g, '_')
    .slice(0, 80);
}

function fileBaseName(filename) {
  const safe = sanitizeFilename(filename);
  const withoutExt = safe.replace(/\.[a-z0-9]{1,8}$/i, '');
  return withoutExt || 'Uploaded_Audio';
}

function timestampTag(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0'); // 24h
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function makeRecorderState() {
  return {
    mediaRecorder: null,
    chunks: [],
    audioBlob: null,
    previewUrl: '',
    isRecording: false,
    startedAtMs: 0,
    durationMs: 0,
    timerId: null,
    liveLangTimerId: null,
    liveLangInFlight: false,
    liveTxTimerId: null,
    liveTxInFlight: false,
    /** After first live `/api/detect-language` round-trip while recording, we start `/api/live-transcribe` polling. */
    liveTxStartedAfterLang: false,
    /** Chains in-session live `/api/live-transcribe` calls so full preview waits for the last chunk to finish. */
    liveTranscribeTail: Promise.resolve(),
    sourceFilename: '',
    /** Server-side pre-save audio backup (`POST/PUT /api/note-drafts`). */
    serverDraftId: ''
  };
}

function resetRecorder(state) {
  if (state === note) void abandonServerNoteDraft();
  try {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  } catch {
    // ignore
  }
  state.mediaRecorder = null;
  state.chunks = [];
  state.audioBlob = null;
  state.sourceFilename = '';
  state.previewUrl = '';
  state.isRecording = false;
  state.startedAtMs = 0;
  state.durationMs = 0;
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  stopTimer(state, state === note ? noteTimerEl : queryTimerEl);
  stopLiveLanguageDetection(state);
  stopLiveTranscript(state);
  if (state === note && noteDetectedLangEl) {
    noteDetectedLangEl.hidden = true;
    noteDetectedLangEl.textContent = 'Lang: —';
  }
  if (state === note && liveTranscriptEl) {
    if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = true;
    liveTranscriptEl.value = '';
    liveTranscriptEl.disabled = false;
    liveTranscriptEl.readOnly = true;
  }
  if (state === note) {
    stopNoteLangDetectCountdown();
    lastFullPreviewBundle = null;
    noteFullPreviewGateOk = false;
    noteAllowManualSaveFinal = false;
    noteLangDetectionComplete = false;
    noteLastDetectedApiLang = '';
    noteUserOverrodeLanguage = false;
    noteUsedMicForCurrentBlob = false;
    note.liveTranscribeTail = Promise.resolve();
    notePostRecordPipelinePromise = null;
    setNewNoteTranscriptionStages({ live: 'pending', full: 'pending', showRow: false });
    if (noteLanguageWrapEl) noteLanguageWrapEl.hidden = true;
    if (noteLanguageEl) {
      noteLangProgrammatic = true;
      noteLanguageEl.value = '';
      noteLangProgrammatic = false;
    }
    updateGenerateFullPreviewButtonVisibility();
    syncLiveTxLangHeader();
    state.liveTxStartedAfterLang = false;
  }
}

/** Start live STT polling only after the first in-session language probe has finished (avoids overlapping UI). */
function beginLiveTranscriptAfterLanguage(state) {
  if (state !== note) return;
  if (!state.isRecording || state.liveTxStartedAfterLang) return;
  state.liveTxStartedAfterLang = true;
  clearLiveTxPreviewCountdown();
  if (liveTranscriptEl) liveTranscriptEl.value = '';
  if (liveTxStatusEl) liveTxStatusEl.hidden = false;
  setLiveTxPhaseLabel('Live Transcription');
  startLiveTranscript(state);
}

function uiState(state) {
  return {
    isRecording: !!state.isRecording,
    hasAudio: !!state.audioBlob,
    previewUrl: state.previewUrl || ''
  };
}

function startTimer(state, el) {
  if (!el) return;
  el.hidden = false;
  const update = () => {
    const ms = Math.max(0, Date.now() - (state.startedAtMs || Date.now()));
    el.textContent = formatMs(ms);
  };
  update();
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(update, 250);
}

function stopTimer(state, el) {
  if (state?.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
  if (!el) return;
  el.hidden = true;
}

function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderBitrateHint() {
  const kbps = Math.round(AUDIO_BITS_PER_SECOND / 1000);
  // Boxes/toggles live in the Help card now; if it isn't present, skip.
  if (!document.getElementById('helpCard')) return;
  const aboutBox = document.getElementById('aboutBox');
  const uiStepsBox = document.getElementById('uiStepsBox');
  if (aboutBox) {
    aboutBox.innerHTML = `
      <div>Audio is recorded at <strong>${kbps} kbps</strong>. Maximum length is about <strong>100 minutes</strong> per note.</div>
      <div style="margin-top:6px">Transcription runs on the server with <strong>ElevenLabs STT</strong>. Saving runs <strong>offline</strong> indexing for search.</div>
      <div style="margin-top:6px">After you stop recording or pick a file, the app <strong>backs up audio to the server</strong> in the background so a failed <strong>Save</strong> is easier to recover from (tap Save again).</div>
      <div style="margin-top:6px">
        Notes store <strong>timestamped segments</strong>; use each segment’s <strong>Play</strong> for a clip, or full <strong>Play Audio</strong> for the whole file.
      </div>
        <div style="margin-top:6px">
        <strong>Search</strong> blends keyword matching with local <strong>semantic</strong> retrieval over segments. Type normally or use filters like <strong>today</strong>, <strong>yesterday</strong>, or a calendar date.
        </div>
      <div style="margin-top:6px">
        <strong>Processing:</strong> the note shows an <strong>approximate time left</strong> (from clip length). If it reaches <strong>0:00</strong> and transcription is still running, the estimate <strong>extends</strong> so you can see work is ongoing. The results list <strong>refreshes</strong> when a note becomes Ready. <strong>Pause</strong> / <strong>Stop</strong> apply only to that note.
      </div>
      <div style="margin-top:6px">
        <strong>Reprocess</strong> (Ready → ▼) runs transcription again with <strong>automatic language detection</strong>. While <strong>any</strong> note is still processing, Reprocess is hidden on other notes to avoid overlapping runs.
      </div>
      <div style="margin-top:6px">
        <strong>Layout:</strong> <strong>Saved notes</strong> (results) are on top. <strong>Search</strong>, <strong>Processes</strong>, <strong>+</strong> (new note), and <strong>Help</strong> are quick actions at the bottom—only <strong>one</strong> panel is open at a time. Each opens in the stack under the list; <strong>×</strong> closes it. No side-by-side split.
      </div>
      <div style="margin-top:6px">
        In Help, <strong>App hint</strong> and <strong>UI steps</strong> only show one at a time; <strong>Hide …</strong> on either closes the whole Help card.
      </div>
    `.trim();
  }

  if (uiStepsBox) {
    uiStepsBox.innerHTML = `
        <div style="margin-top:6px">
        1) Tap <strong>+</strong> in the quick-action bar to open <strong>New note</strong> (it closes any other open panel). Title defaults to <strong>Recording_YYYY-MM-DD_HH-MM-SS</strong> for mic audio or <strong>Upload_YYYY-MM-DD_HH-MM-SS</strong> after <strong>Upload</strong> — change it if you like.
        </div>
        <div style="margin-top:4px">
        2) Optional: <strong>Upload</strong> to pick a file, or tap <strong>Record note</strong>, speak, then <strong>Stop</strong>.
        </div>
        <div style="margin-top:4px">
        3) Pick <strong>Language</strong> or leave <strong>Auto-detect</strong>; the full transcript preview starts automatically when the language is known. Edit the <strong>Transcript preview</strong> after it finishes.
        </div>
        <div style="margin-top:4px">
        4) Tap <strong>Save Note</strong>. Status moves through <strong>Processing</strong> → <strong>Ready</strong>. While processing, an approximate <strong>percent left</strong> is shown (from audio length and elapsed time, not a byte meter from the engine). Use <strong>Pause processing</strong> / <strong>Stop</strong> only for that note.
        </div>
        <div style="margin-top:4px">
        5) <strong>Search:</strong> open the Search card from the quick-action <strong>Search</strong> button, then type and press <strong>Enter</strong>, or use the <strong>mic</strong> (record) → <strong>Stop</strong> → <strong>find</strong> (search) buttons. <strong>×</strong> collapses Search again.
        </div>
        <div style="margin-top:4px">
        6) In results, <strong>Expand</strong> a note for transcript + audio. When <strong>Ready</strong>, <strong>▼</strong> includes <strong>Reprocess</strong> (re-run transcription + language detection), <strong>Play Audio</strong>, downloads, <strong>Edit</strong>, <strong>Delete</strong>. While <strong>another</strong> note is still processing, <strong>Reprocess</strong> is hidden on other notes. (<strong>Edit</strong> hides in that menu while you’re already editing that note.)
        </div>
        <div style="margin-top:4px">
        7) Expanded notes: per-segment <strong>Play</strong> for clips; adjust <strong>Speed</strong> / <strong>Loop segment</strong> as needed. Expanding scrolls the row into view; only the <strong>last</strong> result uses a full scroll to the bottom of the page.
        </div>
        <div style="margin-top:4px">
        8) Tap <strong>Help</strong> for this panel. <strong>App hint</strong> vs <strong>UI steps</strong> toggle each other off; <strong>Hide …</strong> closes Help entirely.
        </div>
        <div style="margin-top:4px">
        9) <strong>Processes</strong> opens the jobs / ingestion panel. Opening it closes Search, New note, and Help; only one of the four panels stays open.
        </div>
      <div style="margin-top:4px">
        Tip: Try queries like <strong>yesterday</strong> or <strong>between 2026-04-20 and 2026-04-22</strong> with your search text.
      </div>
    `.trim();
  }

  const aboutToggle = document.getElementById('aboutToggle');
  const toggle = document.getElementById('uiStepsToggle');
  const box = uiStepsBox;
  if (aboutToggle && aboutBox) {
    aboutToggle.addEventListener('click', () => {
      const nextHidden = !aboutBox.hidden;
      aboutBox.hidden = nextHidden;
      aboutToggle.textContent = nextHidden ? 'App hint' : 'Hide App hint';
      if (!nextHidden) {
        if (box) box.hidden = true;
        if (toggle) toggle.textContent = 'UI steps';
      } else {
        setHelpPanelOpen(false);
      }
      updateMainGridLayout({ prefer: 'auto' });
      if (!nextHidden) scheduleScrollPageBottomAfterExpand();
    });
  }
  if (toggle && box) {
    toggle.addEventListener('click', () => {
      const nextHidden = !box.hidden;
      box.hidden = nextHidden;
      toggle.textContent = nextHidden ? 'UI steps' : 'Hide UI steps';
      if (!nextHidden) {
        if (aboutBox) aboutBox.hidden = true;
        if (aboutToggle) aboutToggle.textContent = 'App hint';
      } else {
        setHelpPanelOpen(false);
      }
      updateMainGridLayout({ prefer: 'auto' });
      if (!nextHidden) scheduleScrollPageBottomAfterExpand();
    });
  }
}

function syncVisibility() {
  // Note buttons
  btnRecordNote.hidden = note.isRecording;
  btnRecordNote.disabled = note.isRecording;
  btnStopNote.hidden = !note.isRecording;
  btnStopNote.disabled = !note.isRecording;
  // UX: keep Save hidden until full transcription generation has started at least once.
  const fullGenerating = !!(liveTxStatusEl && !liveTxStatusEl.hidden && (liveTxPhaseLabelEl?.textContent ?? '') === 'Full Transcription');
  const fullGeneratedOrFailed = noteFullPreviewGateOk || noteAllowManualSaveFinal;
  btnSaveNote.hidden = !note.audioBlob || note.isRecording || (!fullGenerating && !fullGeneratedOrFailed);
  const textOk = !!(liveTranscriptEl && vvFormatTranscript(liveTranscriptEl.value ?? '').trim());
  const saveBusy = !!transcribeFullPreviewInFlight || noteTranscriptionPipelineBusy;
  const saveAllowed = noteFullPreviewGateOk || noteAllowManualSaveFinal;
  btnSaveNote.disabled =
    !note.audioBlob || note.isRecording || !saveAllowed || !textOk || saveBusy;
  updateGenerateFullPreviewButtonVisibility();
  if (noteDetectedLangEl) noteDetectedLangEl.hidden = !note.isRecording && !note.audioBlob;

  // Search buttons
  btnRecordQuery.hidden = query.isRecording;
  btnStopQuery.hidden = !query.isRecording;
  const hideSearch = (qEl.value.trim().length === 0 && !query.audioBlob) || query.isRecording;
  btnSearch.hidden = hideSearch;
  btnSearch.disabled = hideSearch;

  // Removed: Quick answer button
}

function isSemanticMode() {
  return !!semanticMode;
}

function setSemanticMode(on) {
  semanticMode = !!on;
  try {
    localStorage.setItem('vv_semantic_mode', semanticMode ? '1' : '0');
  } catch {
    // ignore
  }
  // If the dot exists (older cached HTML), keep it in sync anyway.
  if (semanticModeDotEl) {
    semanticModeDotEl.classList.toggle('isOn', semanticMode);
    semanticModeDotEl.setAttribute('aria-pressed', semanticMode ? 'true' : 'false');
  }
  if (btnSemanticToggleEl) {
    btnSemanticToggleEl.classList.toggle('primary', semanticMode);
    btnSemanticToggleEl.textContent = semanticMode ? 'Semantic search: On' : 'Semantic search: Off';
    btnSemanticToggleEl.setAttribute('aria-pressed', semanticMode ? 'true' : 'false');
  }
}

async function detectLanguageForNotePreview() {
  if (!note.audioBlob) {
    noteLangDetectionComplete = true;
    syncLiveTxLangHeader();
    updateGenerateFullPreviewButtonVisibility();
    return;
  }

  const manualHintEarly = (noteLanguageEl?.value ?? '').toString().trim();
  if (manualHintEarly || noteUserOverrodeLanguage) {
    noteLangDetectionComplete = false;
    syncLiveTxLangHeader();
    updateGenerateFullPreviewButtonVisibility();
    if (noteLanguageWrapEl?.hidden) startNoteLangDetectCountdown();
    try {
      if (noteDetectedLangEl) {
        noteDetectedLangEl.hidden = false;
        const label = manualHintEarly ? formatNoteLanguageMeta(manualHintEarly) || manualHintEarly : '—';
        noteDetectedLangEl.textContent = manualHintEarly ? `Lang: ${label}` : 'Lang: —';
      }
      revealNoteLanguageWrap();
    } finally {
      stopNoteLangDetectCountdown();
      noteLangDetectionComplete = true;
      syncLiveTxLangHeader();
      updateGenerateFullPreviewButtonVisibility();
    }
    return;
  }

  noteLangDetectionComplete = false;
  syncLiveTxLangHeader();
  updateGenerateFullPreviewButtonVisibility();
  if (noteLanguageWrapEl?.hidden) startNoteLangDetectCountdown();

  try {
    if (!noteDetectedLangEl) return;

    noteDetectedLangEl.hidden = false;
    noteDetectedLangEl.textContent = 'Lang: detecting…';

    const fd = new FormData();
    fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));
    fd.append('stt_provider', getNewNoteSttProvider());

    const resp = await fetch('/api/detect-language', { method: 'POST', body: fd });
    if (!resp.ok) {
      const hasManual = !!(noteLanguageEl?.value ?? '').toString().trim() || noteUserOverrodeLanguage;
      if (!hasManual) noteDetectedLangEl.textContent = 'Lang: —';
      revealNoteLanguageWrap();
      return;
    }
    const data = await safeJson(resp);
    const lang = (data?.language ?? '').toString().trim();
    if (!lang) {
      const hasManual = !!(noteLanguageEl?.value ?? '').toString().trim() || noteUserOverrodeLanguage;
      if (!hasManual) noteDetectedLangEl.textContent = 'Lang: —';
      revealNoteLanguageWrap();
      return;
    }
    if (!noteUserOverrodeLanguage) {
      noteLastDetectedApiLang = lang;
      applyDetectedLanguageToPillAndSelect(lang);
    } else {
      revealNoteLanguageWrap();
    }

    // Uploads skip live transcription; ensure full preview still runs if apply did not start it (e.g. early return).
    if (!note.isRecording && note.audioBlob && !transcribeFullPreviewInFlight) {
      void transcribeFullPreview({ restart: false }).then(() => syncVisibility());
    }
  } finally {
    stopNoteLangDetectCountdown();
    noteLangDetectionComplete = true;
    syncLiveTxLangHeader();
    updateGenerateFullPreviewButtonVisibility();
  }
}

function startLiveLanguageDetection(state) {
  if (state.liveLangTimerId) clearInterval(state.liveLangTimerId);
  if (!noteDetectedLangEl) return;
  // Keep the auto-detect UI hidden while recording; countdown begins only after Stop.
  noteDetectedLangEl.hidden = true;

  state.liveLangTimerId = setInterval(() => {
    if (!state.isRecording) return;
    if (state.liveLangInFlight) return;
    if (!state.chunks || state.chunks.length < 2) return;

    const blob = buildSlidingWebmBlobForLiveStt(state, LIVE_LANG_PROBE_MAX_WINDOW_MS);
    if (!blob || blob.size < 12_000) return; // wait for enough audio

    state.liveLangInFlight = true;
    const fd = new FormData();
    fd.append('audio', blob, guessFilename(blob.type));
    fd.append('stt_provider', getNewNoteSttProvider());

    fetch('/api/detect-language', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const lang = (data?.language ?? '').toString().trim();
        if (!lang) return;
        // Store for use after Stop; do not reveal UI while recording.
        state.liveDetectedLang = lang;
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        state.liveLangInFlight = false;
        if (state === note && state.isRecording && !state.liveTxStartedAfterLang) {
          beginLiveTranscriptAfterLanguage(state);
        }
      });
  }, LIVE_LANG_DETECT_INTERVAL_MS);
}

function stopLiveLanguageDetection(state) {
  if (state?.liveLangTimerId) {
    clearInterval(state.liveLangTimerId);
    state.liveLangTimerId = null;
  }
  if (state) state.liveLangInFlight = false;
}

function bootstrapAutoTitle() {
  // Only auto-fill if empty on first load.
  if (!titleEl.value.trim()) {
    titleEl.value = defaultNoteTitleFromState(note);
  }
}

function ensureAutoTitleFilled(state = note) {
  if (titleEl.value.trim()) return;
  titleEl.value = defaultNoteTitleFromState(state);
}

function defaultRecordingTitle() {
  return `Recording_${timestampTag()}`;
}

function defaultUploadTitle() {
  return `Upload_${timestampTag()}`;
}

function defaultNoteTitleFromState(state) {
  if ((state?.sourceFilename ?? '').toString().trim()) return defaultUploadTitle();
  return defaultRecordingTitle();
}

// (Removed auto-incrementing Recording counter; titles are timestamp-based now.)

