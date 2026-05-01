const statusEl = document.getElementById('status');
const btnRecordNote = document.getElementById('btnRecordNote');
const btnRecordNoteFast = document.getElementById('btnRecordNoteFast');
const btnStopNote = document.getElementById('btnStopNote');
const btnSaveNote = document.getElementById('btnSaveNote');
const previewNote = document.getElementById('previewNote');
const titleEl = document.getElementById('title');
const noteTimerEl = document.getElementById('noteTimer');
const noteDetectedLangEl = document.getElementById('noteDetectedLang');
const noteLanguageEl = document.getElementById('noteLanguage');
const fastModeDotEl = document.getElementById('fastModeDot');
const uploadNoteEl = document.getElementById('uploadNote');
const uploadNoteBtnEl = document.getElementById('uploadNoteBtn');
const uploadNoteNameEl = document.getElementById('uploadNoteName');
const liveTranscriptEl = document.getElementById('liveTranscript');
const liveTranscriptWrapEl = document.getElementById('liveTranscriptWrap');
const liveTxUpEl = document.getElementById('liveTxUp');
const liveTxDownEl = document.getElementById('liveTxDown');
const liveTxStatusEl = document.getElementById('liveTxStatus');

const qEl = document.getElementById('q');
const btnSearch = document.getElementById('btnSearch');
const btnRecordQuery = document.getElementById('btnRecordQuery');
const btnStopQuery = document.getElementById('btnStopQuery');
const previewQuery = document.getElementById('previewQuery');
const resultsEl = document.getElementById('results');
const queryTimerEl = document.getElementById('queryTimer');
const sideWindowsEl = document.getElementById('sideWindows');
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
const btnProcToggleEl = document.getElementById('btnProcToggle');
const procBodyEl = document.getElementById('procBody');
const processCardEl = document.getElementById('processCard');
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

let note = makeRecorderState();
let query = makeRecorderState();

// Keep UI stable across polling refreshes
const expandedNoteIds = new Set();
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

function updateMainGridLayout({ prefer = 'auto' } = {}) {
  if (!mainGridEl) return;
  const noteCollapsed = !!newNoteBodyEl?.hidden;
  const procCollapsed = !!procBodyEl?.hidden;
  // Help is considered "open" if either App hint or UI steps is expanded.
  const aboutBoxEl = document.getElementById('aboutBox');
  const uiStepsBoxEl = document.getElementById('uiStepsBox');
  const helpCollapsed =
    aboutBoxEl && uiStepsBoxEl
      ? !!aboutBoxEl.hidden && !!uiStepsBoxEl.hidden
      : !!helpBodyEl?.hidden;

  // Explicit set/clear (more reliable than toggle chains if multiple calls happen).
  mainGridEl.classList.remove('noteCollapsed', 'procCollapsed', 'helpCollapsed');
  if (noteCollapsed) mainGridEl.classList.add('noteCollapsed');
  if (procCollapsed) mainGridEl.classList.add('procCollapsed');
  if (helpCollapsed) mainGridEl.classList.add('helpCollapsed');

  // Layout rule (per your UX requirement):
  // - Pressing Show/+ on ANY window should restore 50/50 immediately.
  // - Pressing Hide on ANY window should widen Search.
  // We store the last action as a mode, and only fall back to 'auto' when needed.
  if (prefer !== 'auto') gridLayoutMode = prefer;

  const anyCollapsed = noteCollapsed || procCollapsed || helpCollapsed;
  const resolved =
    gridLayoutMode === 'equal' ? 'equal' : gridLayoutMode === 'searchWide' ? 'searchWide' : anyCollapsed ? 'searchWide' : 'equal';
  applyMainGridColumns(resolved);

  // Debug hint in status bar (temporary but useful).
  if (statusEl) {
    statusEl.title = `layout: note=${noteCollapsed ? 'collapsed' : 'open'}, proc=${procCollapsed ? 'collapsed' : 'open'}, help=${
      helpCollapsed ? 'collapsed' : 'open'
    }, mode=${gridLayoutMode}`;
  }
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

async function openExclusivePane(which) {
  // Opening one pane collapses the other two.
  if (which === 'note') {
    if (newNoteBodyEl) newNoteBodyEl.hidden = false;
    if (btnNewNoteToggleEl) btnNewNoteToggleEl.textContent = 'x';

    if (procBodyEl) procBodyEl.hidden = true;
    if (btnProcToggleEl) btnProcToggleEl.textContent = 'Show';

    const aboutBoxEl = document.getElementById('aboutBox');
    const uiStepsBoxEl = document.getElementById('uiStepsBox');
    const aboutToggleEl = document.getElementById('aboutToggle');
    const uiStepsToggleEl = document.getElementById('uiStepsToggle');
    if (aboutBoxEl) aboutBoxEl.hidden = true;
    if (uiStepsBoxEl) uiStepsBoxEl.hidden = true;
    if (aboutToggleEl) aboutToggleEl.textContent = 'App hint';
    if (uiStepsToggleEl) uiStepsToggleEl.textContent = 'UI steps';

    // Opening any pane should restore 50/50.
    updateMainGridLayout({ prefer: 'equal' });
    return;
  }

  if (which === 'proc') {
    if (procBodyEl) procBodyEl.hidden = false;
    if (btnProcToggleEl) btnProcToggleEl.textContent = 'Hide';

    if (newNoteBodyEl) newNoteBodyEl.hidden = true;
    if (btnNewNoteToggleEl) btnNewNoteToggleEl.textContent = '+';

    const aboutBoxEl = document.getElementById('aboutBox');
    const uiStepsBoxEl = document.getElementById('uiStepsBox');
    const aboutToggleEl = document.getElementById('aboutToggle');
    const uiStepsToggleEl = document.getElementById('uiStepsToggle');
    if (aboutBoxEl) aboutBoxEl.hidden = true;
    if (uiStepsBoxEl) uiStepsBoxEl.hidden = true;
    if (aboutToggleEl) aboutToggleEl.textContent = 'App hint';
    if (uiStepsToggleEl) uiStepsToggleEl.textContent = 'UI steps';

    // When opening Processes, refresh its contents.
    try {
      await refreshIngestionUi({ toggleList: false, forceShow: true });
    } catch {
      // ignore
    }

    updateMainGridLayout({ prefer: 'equal' });
    return;
  }

  if (which === 'help') {
    if (newNoteBodyEl) newNoteBodyEl.hidden = true;
    if (btnNewNoteToggleEl) btnNewNoteToggleEl.textContent = '+';

    if (procBodyEl) procBodyEl.hidden = true;
    if (btnProcToggleEl) btnProcToggleEl.textContent = 'Show';

    updateMainGridLayout({ prefer: 'equal' });
  }
}

bootstrapAutoTitle();
noteTimerEl?.setAttribute('hidden', '');
queryTimerEl?.setAttribute('hidden', '');
noteDetectedLangEl?.setAttribute('hidden', '');
stopTimer(note, noteTimerEl);
stopTimer(query, queryTimerEl);
renderBitrateHint();
setFastMode(true);

setStatus('Ready');
wire();
setSemanticMode(semanticMode);
await refreshResults();
refreshIngestionUi().catch(() => {
  // ignore
});
syncVisibility();
startProcessingTimers();

function wire() {
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
    if (!newNoteBodyEl) return;
    const nextHidden = !newNoteBodyEl.hidden;
    newNoteBodyEl.hidden = nextHidden;
    // x when expanded, + when collapsed
    btnNewNoteToggleEl.textContent = nextHidden ? '+' : 'x';
    if (!nextHidden) openExclusivePane('note');
    else updateMainGridLayout({ prefer: 'searchWide' });
  });

  btnRecordNote.addEventListener('click', () =>
    startRecording(note, {
      onUi: (s) => {
        btnRecordNote.hidden = s.isRecording;
        btnRecordNote.disabled = s.isRecording;
        btnRecordNoteFast.hidden = s.isRecording;
        btnRecordNoteFast.disabled = s.isRecording;
        btnStopNote.hidden = !s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        btnSaveNote.hidden = !s.hasAudio || s.isRecording;
        btnSaveNote.disabled = !s.hasAudio || s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
        if (liveTranscriptEl) liveTranscriptEl.disabled = s.isRecording;
      },
      label: 'note'
    })
  );

  btnRecordNoteFast.addEventListener('click', () => {
    setFastMode(true);
    startRecording(note, {
      onUi: (s) => {
        btnRecordNote.hidden = s.isRecording;
        btnRecordNote.disabled = s.isRecording;
        btnRecordNoteFast.hidden = s.isRecording;
        btnRecordNoteFast.disabled = s.isRecording;
        btnStopNote.hidden = !s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        btnSaveNote.hidden = !s.hasAudio || s.isRecording;
        btnSaveNote.disabled = !s.hasAudio || s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
        if (liveTranscriptEl) liveTranscriptEl.disabled = s.isRecording;
      },
      label: 'note'
    });
  });

  btnStopNote.addEventListener('click', () =>
    stopRecording(note, {
      onUi: (s) => {
        btnRecordNote.hidden = s.isRecording;
        btnRecordNote.disabled = s.isRecording;
        btnRecordNoteFast.hidden = s.isRecording;
        btnRecordNoteFast.disabled = s.isRecording;
        btnStopNote.hidden = !s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        btnSaveNote.hidden = !s.hasAudio || s.isRecording;
        btnSaveNote.disabled = !s.hasAudio || s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
        if (liveTranscriptEl) liveTranscriptEl.disabled = s.isRecording;
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

  noteLanguageEl?.addEventListener('change', () => {
    const v = (noteLanguageEl.value ?? '').toString().trim();
    if (noteDetectedLangEl) {
      noteDetectedLangEl.hidden = !note.audioBlob && !note.isRecording;
      noteDetectedLangEl.textContent = v ? `Lang: ${v}` : 'Lang: —';
    }
    if (note.audioBlob) {
      transcribeFullPreview().catch(() => {
        // ignore
      });
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

    // Use the same style as recorded audio titles, but indicate it was uploaded.
    titleEl.value = `Upload_${timestampTag()}`;
    syncVisibility();
    setStatus(`Loaded audio file: ${f.name}`);

    // Detect language for uploaded audio too.
    detectLanguageForNotePreview().catch(() => {
      // ignore
    });

    // Show full transcript preview after upload.
    transcribeFullPreview().catch(() => {
      // ignore
    });

    if (liveTranscriptEl) liveTranscriptEl.disabled = false;
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

  fastModeDotEl?.addEventListener('click', () => {
    setFastMode(!isFastMode());
    if (note.isRecording) return;
    if (note.audioBlob) {
      transcribeFullPreview().catch(() => {
        // ignore
      });
    }
  });

  qEl.addEventListener('input', () => {
    // While recording, ignore manual changes (input should be disabled anyway).
    if (query.isRecording) return;

    const shouldHide = qEl.value.trim().length === 0 && !query.audioBlob;
    btnSearch.hidden = shouldHide;
    btnSearch.disabled = shouldHide;

    // If user clears search transcript, treat it as "finished / wrong search":
    // - show all notes
    // - clear search audio preview and reset search recorder state
    if (qEl.value.trim().length === 0) {
      resetRecorder(query);
      previewQuery.hidden = true;
      previewQuery.src = '';
      refreshResults('').catch(() => {
        // ignore
      });
    }

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
      await refreshIngestionUi();
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
      await refreshIngestionUi();
    } catch {
      // ignore
    } finally {
      btnIngestResumeEl.disabled = false;
    }
  });

  btnProcToggleEl?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!procBodyEl) return;
    const willShow = procBodyEl.hidden;
    procBodyEl.hidden = !willShow;
    btnProcToggleEl.textContent = willShow ? 'Hide' : 'Show';
    if (willShow) await openExclusivePane('proc');
    else updateMainGridLayout({ prefer: 'searchWide' });
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

  // Default mutual-exclusion state on load/refresh:
  // Keep all three panes collapsed by default.
  try {
    if (newNoteBodyEl) newNoteBodyEl.hidden = true;
    if (btnNewNoteToggleEl) btnNewNoteToggleEl.textContent = '+';
    if (procBodyEl) procBodyEl.hidden = true;
    if (btnProcToggleEl) btnProcToggleEl.textContent = 'Show';
    // Help buttons stay visible; collapse means both sections are hidden.
    const aboutBoxEl = document.getElementById('aboutBox');
    const uiStepsBoxEl = document.getElementById('uiStepsBox');
    const aboutToggleEl = document.getElementById('aboutToggle');
    const uiStepsToggleEl = document.getElementById('uiStepsToggle');
    if (aboutBoxEl) aboutBoxEl.hidden = true;
    if (uiStepsBoxEl) uiStepsBoxEl.hidden = true;
    if (aboutToggleEl) aboutToggleEl.textContent = 'App hint';
    if (uiStepsToggleEl) uiStepsToggleEl.textContent = 'UI steps';
    updateMainGridLayout({ prefer: 'searchWide' });
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
    qEl?.focus?.();
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
          .map((f) => `<div style="display:flex; justify-content:space-between; gap:10px"><span>${escapeHtml(String(f.name))}</span><button class="btn err" data-del-folder="${escapeHtml(String(f.id))}" type="button">Delete</button></div>`)
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
          .map((t) => `<div style="display:flex; justify-content:space-between; gap:10px"><span>${escapeHtml(String(t.name))}</span><button class="btn err" data-del-tag="${escapeHtml(String(t.id))}" type="button">Delete</button></div>`)
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
    if (label === 'note') ensureAutoTitleFilled();
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
      onUi?.(uiState(state));
      setStatus(
        `Recorded ${label}: ${(state.audioBlob.size / 1024 / 1024).toFixed(2)} MB`
      );

      if (label === 'note') {
        detectLanguageForNotePreview().catch(() => {
          // ignore
        });
        transcribeFullPreview().catch(() => {
          // ignore
        });
      }
    });

    state.mediaRecorder.start(MEDIARECORDER_TIMESLICE_MS);
    if (label === 'note') {
      startLiveLanguageDetection(state);
      startLiveTranscript(state);
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

async function saveNote() {
  if (!note.audioBlob) return;
  btnSaveNote.disabled = true;
  setStatus('Saving + transcribing…');

  try {
    const fd = new FormData();
    ensureAutoTitleFilled();
    fd.append('title', titleEl.value || '');
    fd.append('duration_ms', Math.round(note.durationMs || 0).toString());
    fd.append('language', (noteLanguageEl?.value ?? '').toString());
    fd.append('fast_mode', isFastMode() ? '1' : '0');
    fd.append('source_filename', (note.sourceFilename ?? '').toString());
    fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));

    const resp = await fetch('/api/notes', { method: 'POST', body: fd });
    if (!resp.ok) {
      const msg = await safeJson(resp);
      throw new Error(msg?.error || `Upload failed (${resp.status})`);
    }
    const data = await safeJson(resp);

    titleEl.value = '';
    resetRecorder(note);
    previewNote.hidden = true;
    previewNote.src = '';
    if (noteLanguageEl) noteLanguageEl.value = '';
    // Keep fast mode enabled by default; 'medium' can be very slow on CPU.
    setFastMode(true);
    syncVisibility();

    const id = (data?.id ?? '').toString().trim();
    setStatus('Saved. Transcribing offline…');
    await refreshResults(qEl.value);
    if (id) pollNoteUntilDone(id);

    titleEl.value = defaultRecordingTitle();
  } catch (err) {
    setStatus(`Save/transcribe error: ${err?.message ?? err}`, true);
    btnSaveNote.disabled = false;
  }
}

async function refreshResults(q = '') {
  const prevScroll = resultsEl.scrollTop;
  // Any "Search" refresh should show the results list (Quick answer may hide it separately).
  resultsEl.hidden = false;
  resultsEl.innerHTML = '';
  const isSearch = !!(q && q.trim());
  const queryText = (q ?? '').toString().trim();
  if (isSearch) recordRecentSearch(queryText);

  let items = [];
  if (!isSearch) {
    // Empty query: show saved notes (keyword path).
    const url = new URL('/api/notes', window.location.origin);
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      resultsEl.innerHTML = `<div class="note err">Failed to load notes</div>`;
      return;
    }
    const data = await resp.json();
    items = Array.isArray(data?.items) ? data.items : [];
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
      resultsEl.innerHTML = `<div class="note err">Failed to load notes</div>`;
      return;
    }
    const semJson = await safeJson(semResp);
    const ftsJson = await safeJson(ftsResp);
    const semItems = Array.isArray(semJson?.items) ? semJson.items : [];
    const ftsItems = Array.isArray(ftsJson?.items) ? ftsJson.items : [];

    const byId = new Map();
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
        byId.set(id, { ...it, ...cur, matches: cur?.matches ?? it?.matches ?? [], _vvSort: cur?._vvSort ?? 0 });
      }
    }
    items = Array.from(byId.values());
    items.sort((a, b) => (Number(b?._vvSort ?? 0) || 0) - (Number(a?._vvSort ?? 0) || 0));
    items = items.map((x) => {
      const { _vvSort, ...rest } = x || {};
      return rest;
    });
  }

  lastSearchItems = Array.isArray(items) ? items : [];
  lastSearchQuery = isSearch ? queryText : '';
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
    resultsEl.innerHTML = `<div class="note"><div class="pill">No results</div></div>`;
    return;
  }

  // Auto-expand Processes when any note is in error.
  const hasErrorNote = items.some((it) => (it?.status ?? '').toString() === 'error');
  if (hasErrorNote) {
    openExclusivePane('proc').catch(() => {
      // ignore
    });
  }

  for (const item of items) {
    const note = document.createElement('div');
    note.className = 'note noteCollapsed';

    const created = new Date(item.created_at).toLocaleString();
    const createdAtIso = (item.created_at ?? '').toString();
    const status = (item.status ?? '').toString();
    const errText = (item.error ?? '').toString().trim();
    const durationMs = Number(item.duration_ms ?? 0) || 0;
    const lang = (item.language ?? '').toString().trim();
    const fav = Number(item.is_favorite ?? 0) ? true : false;
    const procPaused = Number(item.processing_paused ?? 0) ? true : false;
    const title = escapeHtml(item.title || 'Untitled');
    const body = escapeHtml(item.body || '');

    note.innerHTML = `
      <div class="noteSummary">
        <div class="noteTitleRow">
          <div class="noteTitle">${title}</div>
          <div class="noteTitleRight">
            <div class="noteMeta">${created}</div>
          </div>
        </div>
        <div style="margin-top:6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
          <button class="btn ${fav ? 'primary' : ''}" data-fav="${item.id}" type="button" title="Toggle favorite">${fav ? '★' : '☆'}</button>
          ${
            status
              ? status === 'ready'
                ? `<span class="noteStatus ready">Ready</span>`
                : status === 'processing'
                  ? `<span class="noteStatus">Processing <span class="noteProcessingTime" data-created-at="${escapeHtml(
                      createdAtIso
                    )}">00:00</span></span>`
                  : status === 'error'
                    ? `<span class="noteStatus err">Error</span>`
                    : `<span class="noteStatus">${escapeHtml(status)}</span>`
              : ''
          }
          ${durationMs > 0 ? `<span class="pill noteLength">Length ${escapeHtml(formatMs(durationMs))}</span>` : ''}
          ${lang ? `<span class="pill timerPill">Lang: ${escapeHtml(lang)}</span>` : ''}
          ${
            status === 'ready'
              ? `<button class="btn" data-toggle="${item.id}" aria-label="Toggle note details">Expand</button>
                 <div class="noteActionsWrap" data-actions-wrap="${item.id}">
                   <button class="btn noteActionsChevron" data-actions-toggle="${item.id}" aria-label="Toggle actions">▼</button>
                   <div class="noteActions" data-actions-menu="${item.id}" hidden>
                     <div class="noteActionsList">
                       <button class="btn" data-play="${item.id}">Play Audio</button>
                       <button class="btn" data-dl-audio="${item.id}">Download Audio</button>
                       <button class="btn" data-dl-text="${item.id}">Download Transcript</button>
                       <button class="btn" data-edit="${item.id}">Edit</button>
                       <button class="btn" data-delete="${item.id}">Delete Note</button>
                     </div>
                   </div>
                 </div>`
              : ''
          }
          ${
            status === 'processing'
              ? `<button class="btn err" data-remove="${item.id}" title="Delete this note and stop processing">Remove</button>`
              : ''
          }
          ${
            status === 'processing'
              ? `<button class="btn ${procPaused ? 'primary' : ''}" data-proc-toggle="${item.id}" type="button" title="Pause/resume jobs for this note">${procPaused ? 'Resume processing' : 'Pause processing'}</button>`
              : ''
          }
          ${
            status === 'processing'
              ? `<label class="label" style="margin:0; display:flex; align-items:center; gap:8px">
                  <span style="font-size:12px; color:rgba(255,255,255,0.72); font-weight:750">Priority</span>
                  <select class="jobsSelect" data-proc-priority="${item.id}" style="min-width:120px">
                    <option value="2">High</option>
                    <option value="0">Normal</option>
                    <option value="-2">Low</option>
                  </select>
                </label>`
              : ''
          }
        </div>

      </div>

      <div class="noteDetails" hidden>
        <div class="noteTranscript">
          <div class="noteBody">${
            status === 'processing'
              ? `<span class="pill">Transcribing…</span>`
              : status === 'error'
                ? `<div class="pill err">Transcription failed</div><div style="margin-top:8px">${escapeHtml(
                    errText || 'Unknown error'
                  )}</div>`
                : body
          }</div>
        </div>
        <div class="noteScrollHint" hidden>More transcript below</div>

        <div class="row notePlaybackRow" style="margin-top:8px; margin-bottom:0; gap:10px; flex-wrap:wrap">
          <label class="label" style="margin:0; display:flex; align-items:center; gap:10px">
            <span style="font-size:12px; color:rgba(255,255,255,0.72); font-weight:750">Speed</span>
            <select class="jobsSelect" data-rate="${item.id}">
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </label>
          <button class="btn" data-loop="${item.id}" type="button" aria-pressed="false" title="Loop played segments">Loop segment</button>
        </div>

        <audio class="audio" controls hidden></audio>

        <div class="editBox" hidden>
          <label class="label">
            Title
            <input class="input editTitle" />
          </label>
          <label class="label">
            Transcript
            <textarea class="textarea editBody" rows="8"></textarea>
          </label>
          <div class="row" style="margin-bottom:0">
            <button class="btn primary" data-save="${item.id}">Save</button>
            <button class="btn" data-cancel="${item.id}">Cancel</button>
          </div>
        </div>
      </div>
    `;

    const summary = note.querySelector('.noteSummary');
    const actionsMenu = note.querySelector(`[data-actions-menu="${CSS.escape(String(item.id))}"]`);
    const details = note.querySelector('.noteDetails');
    const scrollHint = note.querySelector('.noteScrollHint');

    const btnToggle = note.querySelector('button[data-toggle]');
    if (btnToggle) {
      // If this is a search and the server provided a best-match segment, auto-expand.
      if (isSearch && item?.best_match && status === 'ready') {
        expandedNoteIds.add(item.id);
      }

      if (expandedNoteIds.has(item.id)) {
        details.hidden = false;
        note.classList.add('noteExpanded');
        note.classList.remove('noteCollapsed');
        btnToggle.textContent = 'Collapse';
        // Best-effort: upgrade transcript to timestamped segments (if available).
        loadNoteSegmentsIntoUi(item.id, note, {
          highlight: item?.matches ?? item?.best_match ?? null,
          autoPlayMatch: false
        }).catch(() => {
          // ignore
        });
      }
      btnToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !details.hidden;
        details.hidden = isOpen;
        note.classList.toggle('noteExpanded', !isOpen);
        note.classList.toggle('noteCollapsed', isOpen);
        btnToggle.textContent = isOpen ? 'Expand' : 'Collapse';
        if (isOpen) expandedNoteIds.add(item.id);
        else expandedNoteIds.delete(item.id);
        if (!isOpen) {
          requestAnimationFrame(() => updateScrollHint(transcriptBox, scrollHint));
        }
        if (!isOpen) {
          loadNoteSegmentsIntoUi(item.id, note, {
            highlight: item?.best_match ?? null,
            autoPlayMatch: false
          }).catch(() => {
            // ignore
          });
        }
      });
    }

    const btnActionsToggle = note.querySelector('button[data-actions-toggle]');
    if (btnActionsToggle && actionsMenu) {
      btnActionsToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        installActionMenuGlobalHandlersOnce();
        const willOpen = actionsMenu.hidden;
        // Always close any other open menus before toggling this one.
        closeAllActionMenus(actionsMenu);
        actionsMenu.hidden = !willOpen;
        btnActionsToggle.textContent = willOpen ? '▲' : '▼';
        if (willOpen) {
          requestAnimationFrame(() => {
            ensureElementFullyVisible(actionsMenu, 8);
          });
        }
      });
    }

    // Playback polish: speed + loop for this note.
    const audioEl = note.querySelector('audio');
    const rateSel = note.querySelector(`select[data-rate="${CSS.escape(String(item.id))}"]`);
    if (rateSel) {
      rateSel.value = String(playbackRate);
      rateSel.addEventListener('change', () => {
        const v = Number(rateSel.value);
        playbackRate = Number.isFinite(v) && v > 0 ? v : 1;
        saveNumberSetting('vv_playback_rate', playbackRate);
        try {
          if (audioEl) audioEl.playbackRate = playbackRate;
        } catch {
          // ignore
        }
      });
    }
    const loopBtn = note.querySelector(`button[data-loop="${CSS.escape(String(item.id))}"]`);
    if (loopBtn) {
      const sync = () => {
        loopBtn.setAttribute('aria-pressed', loopSegments ? 'true' : 'false');
        loopBtn.classList.toggle('primary', loopSegments);
      };
      sync();
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
        const next = b.textContent === '★' ? 0 : 1;
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

    // Per-note processing controls (pause/resume + priority for queued jobs).
    const btnProcToggle = note.querySelector(`button[data-proc-toggle="${CSS.escape(String(item.id))}"]`);
    if (btnProcToggle) {
      btnProcToggle.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const endpoint = procPaused ? 'resume-processing' : 'pause-processing';
          await fetch(`/api/notes/${encodeURIComponent(item.id)}/${endpoint}`, { method: 'POST' });
          await refreshResults(qEl.value);
        } catch {
          // ignore
        }
      });
    }

    const procPrioritySel = note.querySelector(`select[data-proc-priority="${CSS.escape(String(item.id))}"]`);
    if (procPrioritySel) {
      procPrioritySel.value = '0';
      procPrioritySel.addEventListener('change', async () => {
        const p = Number.parseInt((procPrioritySel.value ?? '0').toString(), 10) || 0;
        try {
          await fetch(`/api/notes/${encodeURIComponent(item.id)}/priority`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: p })
          });
        } catch {
          // ignore
        }
      });
    }

    // Tags removed.

    const btn = note.querySelector('button[data-play]');
    const audio = note.querySelector('audio');
    btn.addEventListener('click', async (e) => {
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
        btn.textContent = 'Play Audio';
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
        // If segments are rendered (word spans exist), follow along while playing full audio.
        startWordFollowAll(audio, note.querySelector('.noteBody'));
        btn.textContent = 'Stop Audio';
      } catch {
        // ignore autoplay restrictions
      }
    });

    audio.addEventListener('ended', () => {
      btn.textContent = 'Play Audio';
    });

    const editBox = note.querySelector('.editBox');
    const transcriptBox = note.querySelector('.noteTranscript');
    const editTitle = note.querySelector('.editTitle');
    const editBody = note.querySelector('.editBody');
    const btnEdit = note.querySelector('button[data-edit]');
    const btnDelete = note.querySelector('button[data-delete]');
    const btnRemove = note.querySelector('button[data-remove]');
    const btnDlAudio = note.querySelector('button[data-dl-audio]');
    const btnDlText = note.querySelector('button[data-dl-text]');
    const btnSave = note.querySelector('button[data-save]');
    const btnCancel = note.querySelector('button[data-cancel]');

    transcriptBox?.addEventListener('scroll', () => updateScrollHint(transcriptBox, scrollHint));
    updateScrollHint(transcriptBox, scrollHint);

    btnEdit.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Close the actions dropdown when entering edit mode.
      if (actionsMenu && !actionsMenu.hidden) {
        actionsMenu.hidden = true;
        if (btnActionsToggle) btnActionsToggle.textContent = '▼';
      }
      // Editing UI lives inside details; ensure it's visible.
      if (details?.hidden) {
        details.hidden = false;
        note.classList.add('noteExpanded');
        note.classList.remove('noteCollapsed');
        if (btnToggle) btnToggle.textContent = 'Collapse';
        expandedNoteIds.add(item.id);
      }
      const willShow = !!editBox.hidden;
      editBox.hidden = !willShow;
      if (transcriptBox) transcriptBox.hidden = willShow;
      note.classList.toggle('isEditing', willShow);
      if (willShow) {
        try {
          const resp = await fetch(`/api/notes/${encodeURIComponent(item.id)}`);
          const full = await safeJson(resp);
          if (!resp.ok) throw new Error(full?.error || `Load failed (${resp.status})`);
          editTitle.value = (full?.title ?? item.title ?? '').toString();
          editBody.value = (full?.body ?? item.body ?? '').toString();
        } catch {
          editTitle.value = (item.title ?? '').toString();
          editBody.value = (item.body ?? '').toString();
        }
      }
    });

    btnCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      editBox.hidden = true;
      if (transcriptBox) transcriptBox.hidden = false;
      note.classList.remove('isEditing');
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
            title: editTitle.value || '',
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
        setStatus('Saved');
        await refreshResults(qEl.value);
      } catch (e) {
        setStatus(`Save error: ${e?.message ?? e}`, true);
      } finally {
        btnSave.disabled = false;
      }
    });

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

    btnDlAudio.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = `/api/notes/${encodeURIComponent(item.id)}/audio`;
      a.download = `${sanitizeFilename((item.title || 'recording').toString()) || 'recording'}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    btnDlText.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = (item.body ?? '').toString();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename((item.title || 'transcript').toString()) || 'transcript'}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    resultsEl.appendChild(note);
  }

  requestAnimationFrame(() => {
    resultsEl.scrollTop = prevScroll;
  });
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

  // Replace transcript with clickable timestamped segments.
  bodyEl.innerHTML = renderSegmentsHtml(segments, { highlight, headerText });

  // Delegate clicks to Play buttons (text is not clickable).
  bodyEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const playBtn = target.closest?.('button[data-seg-play]');
    if (!playBtn) return;
    e.preventDefault();
    e.stopPropagation();
    closeAllActionMenus();

    const start = Number(playBtn.getAttribute('data-seg-start') || '0');
    const end = Number(playBtn.getAttribute('data-seg-end') || '0');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    const wantSrc = `/api/notes/${encodeURIComponent(noteId)}/audio`;
    if (audioEl.src !== new URL(wantSrc, window.location.origin).toString()) {
      audioEl.src = wantSrc;
      try {
        audioEl.load();
      } catch {
        // ignore
      }
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
  if (words.length === 0) return;

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

function startWordFollowAll(audioEl, containerEl) {
  if (!audioEl || !containerEl) return;
  const words = Array.from(containerEl.querySelectorAll?.('.word[data-ws][data-we]') ?? []);
  if (words.length === 0) return;

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

    const words = Array.isArray(s?.words) ? s.words : [];
    const wordHtml =
      words.length > 0
        ? words
            .map((w) => {
              const ws = Number(w?.start);
              const we = Number(w?.end);
              const ww = (w?.word ?? '').toString();
              if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws || !ww.trim()) return '';
              return `<span class="word" data-ws="${escapeHtml(String(ws))}" data-we="${escapeHtml(
                String(we)
              )}">${escapeHtml(ww)}</span>`;
            })
            .filter(Boolean)
            .join(' ')
        : '';

    safe.push(`
      <div class="segRow${isMatch ? ' match' : ''}" data-seg-start="${escapeHtml(
      String(start)
    )}" data-seg-end="${escapeHtml(String(end))}">
        <button class="btn segPlay" type="button" data-seg-play="1" data-seg-start="${escapeHtml(
          String(start)
        )}" data-seg-end="${escapeHtml(String(end))}" title="Play ${escapeHtml(
      `${formatClock(start)}–${formatClock(end)}`
    )}">Play</button>
        <span class="segTime">${escapeHtml(`${formatClock(start)}–${formatClock(end)}`)}</span>
        <span class="segText">${wordHtml || escapeHtml(text)}</span>
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

function extractUploadedFilenameHeader(noteJson) {
  const title = (noteJson?.title ?? '').toString().trim();
  const body = (noteJson?.body ?? '').toString();
  const firstLine = (body.split('\n')[0] ?? '').toString().trim();
  if (!firstLine) return '';

  // Heuristic: if we prefixed the transcript with source_filename, it will be the first line.
  // Only show it when it looks like a filename and the note title is an Upload_*.
  const looksLikeFilename =
    firstLine.length <= 140 &&
    (/\.[a-z0-9]{1,8}$/i.test(firstLine) || /[_-]/.test(firstLine) || /\s/.test(firstLine));

  if (title.startsWith('Upload_') && looksLikeFilename) return firstLine;
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
    const els = document.querySelectorAll('.noteProcessingTime[data-created-at]');
    const now = Date.now();
    for (const el of els) {
      const iso = el.getAttribute('data-created-at') || '';
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) continue;
      const ms = Math.max(0, now - t);
      el.textContent = formatMs(ms);
    }
  }, 1000);
}

function startLiveTranscript(state) {
  if (state.liveTxTimerId) clearInterval(state.liveTxTimerId);
  if (!liveTranscriptEl) return;
  if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
  liveTranscriptEl.value = '';
  if (liveTxStatusEl) liveTxStatusEl.hidden = false;

  state.liveTxTimerId = setInterval(() => {
    if (!state.isRecording) return;
    if (state.liveTxInFlight) return;
    if (!state.chunks || state.chunks.length < 5) return;

    const recent = state.chunks.slice(-50); // ~5 seconds worth at 0.1s
    const blob = new Blob(recent, { type: state.mediaRecorder?.mimeType || 'audio/webm' });
    if (blob.size < 18_000) return;

    state.liveTxInFlight = true;
    const fd = new FormData();
    fd.append('language', (noteLanguageEl?.value ?? '').toString());
    fd.append('audio', blob, guessFilename(blob.type));

    fetch('/api/live-transcribe', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const t = (data?.transcript ?? '').toString().trim();
        if (!liveTranscriptEl) return;
        if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
        if (t) {
          liveTranscriptEl.value = t;
          if (liveTxStatusEl) liveTxStatusEl.hidden = true;
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        state.liveTxInFlight = false;
      });
  }, LIVE_TRANSCRIBE_INTERVAL_MS);
}

function stopLiveTranscript(state) {
  if (state?.liveTxTimerId) {
    clearInterval(state.liveTxTimerId);
    state.liveTxTimerId = null;
  }
  if (state) state.liveTxInFlight = false;
  // Keep the last preview visible after stopping.
  if (state === note && liveTxStatusEl) liveTxStatusEl.hidden = true;
}

function startLiveQueryTranscript(state) {
  if (state.liveTxTimerId) clearInterval(state.liveTxTimerId);
  if (!qEl) return;
  qEl.value = '';

  state.liveTxTimerId = setInterval(() => {
    if (!state.isRecording) return;
    if (state.liveTxInFlight) return;
    if (!state.chunks || state.chunks.length < 5) return;

    const recent = state.chunks.slice(-50); // ~5 seconds worth at 0.1s
    const blob = new Blob(recent, { type: state.mediaRecorder?.mimeType || 'audio/webm' });
    if (blob.size < 18_000) return;

    state.liveTxInFlight = true;
    const fd = new FormData();
    fd.append('language', ''); // always auto-detect for search
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

async function transcribeFullPreview() {
  if (!note.audioBlob) return;
  if (!liveTranscriptEl) return;

  if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
  liveTranscriptEl.value = '';
  if (liveTxStatusEl) liveTxStatusEl.hidden = false;

  const fd = new FormData();
  fd.append('language', (noteLanguageEl?.value ?? '').toString());
  fd.append('fast_mode', isFastMode() ? '1' : '0');
  fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));

  const resp = await fetch('/api/transcribe', { method: 'POST', body: fd });
  if (!resp.ok) {
    liveTranscriptEl.value = '(failed to generate preview)';
    if (liveTxStatusEl) liveTxStatusEl.hidden = true;
    return;
  }
  const data = await safeJson(resp);
  const t = (data?.transcript ?? '').toString().trim();
  liveTranscriptEl.value = t;
  if (liveTxStatusEl) liveTxStatusEl.hidden = true;
}

async function refreshIngestionUi({ toggleList = false, forceShow = null } = {}) {
  if (
    !btnIngestPauseEl ||
    !btnIngestResumeEl ||
    !jobsListEl ||
    !btnProcToggleEl ||
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
  )
    return;

  const summaryResp = await fetch('/api/processes/summary');
  if (!summaryResp.ok) return;
  const summary = await summaryResp.json();
  const paused = !!summary?.paused;

  jobsPausedPillEl.hidden = !paused;
  btnIngestPauseEl.hidden = paused;
  btnIngestResumeEl.hidden = !paused;

  const maxParallel = Number(summary?.max_parallel ?? 1) || 1;
  if (!jobsMaxParallelEl.value) jobsMaxParallelEl.value = String(maxParallel);

  const jobs = summary?.jobs ?? {};
  const notes = summary?.notes ?? {};
  const hasFailures = Number(jobs?.error ?? 0) > 0 || Number(notes?.error ?? 0) > 0;

  // Hide the Processes card entirely unless there are failures.
  // If failures appear later, it will show again and can auto-open.
  if (processCardEl) {
    processCardEl.hidden = !hasFailures;
  }
  if (!hasFailures) {
    // Ensure it's collapsed if we hide it.
    if (procBodyEl) procBodyEl.hidden = true;
    if (btnProcToggleEl) btnProcToggleEl.textContent = 'Show';
    return;
  }
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

  // If processes panel is collapsed, don't show inner content.
  if (procBodyEl?.hidden) return;
  if (btnProcToggleEl) btnProcToggleEl.textContent = 'Hide';

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
    if (!resp.ok) return;
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
                  ${canCancel ? `<button class="btn err" data-job-cancel="${escapeHtml(id)}" type="button">Cancel</button>` : ''}
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
          await refreshIngestionUi();
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
          await refreshIngestionUi();
        } catch (err2) {
          setStatus(`Cancel error: ${err2?.message ?? err2}`, true);
        } finally {
          b.disabled = false;
        }
      });
    });
  } else {
    jobsSummaryEl.hidden = true;
    jobsFiltersEl.hidden = true;
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
      }
      await refreshResults(qEl.value);
    } catch {
      // ignore transient errors
    }
  }, intervalMs);
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
    const fd = new FormData();
    fd.append('audio', query.audioBlob, guessFilename(query.audioBlob.type));
    const resp = await fetch('/api/transcribe', { method: 'POST', body: fd });
    if (!resp.ok) {
      const msg = await safeJson(resp);
      throw new Error(msg?.error || `Transcribe failed (${resp.status})`);
    }
    const data = await safeJson(resp);
    const transcript = (data?.transcript ?? '').toString().trim();
    qEl.value = transcript;

    resetRecorder(query);
    previewQuery.hidden = true;
    previewQuery.src = '';

    setStatus(transcript ? `Searching: "${transcript}"` : 'Search transcript empty');
    await refreshResults(transcript);
  } catch (err) {
    setStatus(`Search error: ${err?.message ?? err}`, true);
    btnSearch.disabled = false;
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  const t = (text ?? '').toString().trim().toLowerCase();
  statusEl.className = `status${isError ? ' err' : t === 'ready' ? ' ok' : ''}`;
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
    sourceFilename: ''
  };
}

function resetRecorder(state) {
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
  }
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
      <div>Audio is being recorded at <strong>${kbps} kbps</strong>.</div>
      <div style="margin-top:6px">Maximum audio length limit is <strong>around 100 minutes</strong>.</div>
      <div style="margin-top:6px">This app uses <strong>Whisper</strong> model for transcription.</div>
      <div style="margin-top:6px">
        <strong>Fast mode</strong> is enabled by default (green dot = on). Turn it off for higher quality (slower).
      </div>
      <div style="margin-top:6px">
        When you save, voiceVault will <strong>transcribe offline</strong> and use the transcript for cross-note search.
      </div>
      <div style="margin-top:6px">
        Saved notes include <strong>timestamped segments</strong> — use each segment’s <strong>Play</strong> button to play only that section.
      </div>
      <div style="margin-top:6px">
        Search supports <strong>natural language</strong> (offline rewrite) and <strong>date/time filters</strong> like <strong>today</strong>, <strong>yesterday</strong>,
        <strong>last 3 days</strong>, or <strong>2026-04-22</strong>.
      </div>
      <div style="margin-top:6px">
        Search is <strong>hybrid</strong> by default: it blends keyword matching with local semantic retrieval over transcript segments.
      </div>
    `.trim();
  }

  if (uiStepsBox) {
    uiStepsBox.innerHTML = `
      <div style="margin-top:6px">
        1) Enter/confirm the Title (auto-filled as Recording_YYYY-MM-DD_HH-MM-SS)
      </div>
      <div style="margin-top:4px">
        2) (Optional) Upload audio: click <strong>Choose file</strong> and select an audio file
      </div>
      <div style="margin-top:4px">
        3) Or record: click <strong>Record note</strong> (or <strong>Record with fast mode</strong>) → speak → click <strong>Stop</strong>
      </div>
      <div style="margin-top:4px">
        4) (Optional) Choose <strong>Language</strong> (or keep <strong>Auto-detect</strong>)
      </div>
      <div style="margin-top:4px">
        5) Review <strong>Transcript preview (editable)</strong> (wait for <strong>Processing…</strong>; scroll/edit after Stop)
      </div>
      <div style="margin-top:4px">
        6) Click <strong>Save</strong> (note will show Processing → Ready)
      </div>
      <div style="margin-top:4px">
        7) To find a note: type in Search and press <strong>Enter</strong>, or use <strong>Record search</strong> → <strong>Stop</strong> → <strong>Search</strong>
      </div>
      <div style="margin-top:4px">
        8) In results: use <strong>Expand</strong> to see transcript + playback. Use the <strong>▼</strong> menu for actions (download, edit, delete).
      </div>
      <div style="margin-top:4px">
        9) In expanded notes: use per-segment <strong>Play</strong> for clipped playback; use <strong>Play Audio</strong> for full audio.
      </div>
      <div style="margin-top:4px">
        10) If a note gets stuck on <strong>Processing</strong>, use <strong>Remove</strong> to delete it.
      </div>
      <div style="margin-top:4px">
        Tip: You can ask time-filtered queries like <strong>"recording yesterday"</strong> or <strong>"between 2026-04-20 and 2026-04-22 upload"</strong>.
      </div>
      <div style="margin-top:10px; border-top:1px dotted rgba(255,255,255,0.16); padding-top:10px">
        Layout: The left side has three windows — <strong>New note</strong>, <strong>Processes</strong>, and <strong>Help</strong>.
        Opening any left window restores a <strong>50/50</strong> split with Search; collapsing it makes Search wider.
        Only one window can be open at a time (mutually exclusive). On page load, all three start collapsed by default.
        The <strong>Processes</strong> window stays hidden unless there are failures; if any note is in <strong>Error</strong> state, it auto-opens.
        Help is opened by pressing <strong>App hint</strong> or <strong>UI steps</strong>.
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
      // Mutually exclusive with UI steps
      if (!nextHidden && box) {
        box.hidden = true;
        if (toggle) toggle.textContent = 'UI steps';
      }
      // Bind layout + Help window visibility to App hint.
      if (!nextHidden) {
        openExclusivePane('help').catch(() => {
          // ignore
        });
      } else {
        // If both help sections are hidden, collapse Help and widen Search.
        const nothingOpen = (!!aboutBox?.hidden ?? true) && (!!box?.hidden ?? true);
        if (nothingOpen) {
          updateMainGridLayout({ prefer: 'searchWide' });
        }
      }
    });
  }
  if (toggle && box) {
    toggle.addEventListener('click', () => {
      const nextHidden = !box.hidden;
      box.hidden = nextHidden;
      toggle.textContent = nextHidden ? 'UI steps' : 'Hide UI steps';
      // Mutually exclusive with App hint
      if (!nextHidden && aboutBox) {
        aboutBox.hidden = true;
        if (aboutToggle) aboutToggle.textContent = 'App hint';
      }
      // Bind layout + Help window visibility to UI steps.
      if (!nextHidden) {
        openExclusivePane('help').catch(() => {
          // ignore
        });
      } else {
        const nothingOpen = (!!aboutBox?.hidden ?? true) && (!!box?.hidden ?? true);
        if (nothingOpen) {
          updateMainGridLayout({ prefer: 'searchWide' });
        }
      }
    });
  }
}

function syncVisibility() {
  // Note buttons
  btnRecordNote.hidden = note.isRecording;
  btnRecordNote.disabled = note.isRecording;
  btnRecordNoteFast.hidden = note.isRecording;
  btnRecordNoteFast.disabled = note.isRecording;
  btnStopNote.hidden = !note.isRecording;
  btnStopNote.disabled = !note.isRecording;
  btnSaveNote.hidden = !note.audioBlob || note.isRecording;
  btnSaveNote.disabled = !note.audioBlob || note.isRecording;
  if (noteDetectedLangEl) noteDetectedLangEl.hidden = note.isRecording || !note.audioBlob;

  // Search buttons
  btnRecordQuery.hidden = query.isRecording;
  btnStopQuery.hidden = !query.isRecording;
  const hideSearch = (qEl.value.trim().length === 0 && !query.audioBlob) || query.isRecording;
  btnSearch.hidden = hideSearch;
  btnSearch.disabled = hideSearch;

  // Removed: Quick answer button
}

function isFastMode() {
  return fastModeDotEl?.classList?.contains('isOn') ?? true;
}

function setFastMode(on) {
  if (!fastModeDotEl) return;
  fastModeDotEl.classList.toggle('isOn', !!on);
  fastModeDotEl.setAttribute('aria-pressed', on ? 'true' : 'false');
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
  if (!note.audioBlob) return;
  if (!noteDetectedLangEl) return;

  noteDetectedLangEl.hidden = false;
  noteDetectedLangEl.textContent = 'Lang: detecting…';

  const fd = new FormData();
  fd.append('audio', note.audioBlob, guessFilename(note.audioBlob.type));

  const resp = await fetch('/api/detect-language', { method: 'POST', body: fd });
  if (!resp.ok) {
    noteDetectedLangEl.textContent = 'Lang: —';
    return;
  }
  const data = await safeJson(resp);
  const lang = (data?.language ?? '').toString().trim();
  noteDetectedLangEl.textContent = lang ? `Lang: ${lang}` : 'Lang: —';
}

function startLiveLanguageDetection(state) {
  if (state.liveLangTimerId) clearInterval(state.liveLangTimerId);
  if (!noteDetectedLangEl) return;
  noteDetectedLangEl.hidden = false;
  noteDetectedLangEl.textContent = 'Lang: detecting…';

  state.liveLangTimerId = setInterval(() => {
    if (!state.isRecording) return;
    if (state.liveLangInFlight) return;
    if (!state.chunks || state.chunks.length < 3) return;

    const recent = state.chunks.slice(-30); // ~last few seconds worth of 0.1s chunks
    const blob = new Blob(recent, { type: state.mediaRecorder?.mimeType || 'audio/webm' });
    if (blob.size < 12_000) return; // wait for enough audio

    state.liveLangInFlight = true;
    const fd = new FormData();
    fd.append('audio', blob, guessFilename(blob.type));

    fetch('/api/detect-language', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const lang = (data?.language ?? '').toString().trim();
        if (noteDetectedLangEl && state.isRecording) {
          noteDetectedLangEl.textContent = lang ? `Lang: ${lang}` : 'Lang: —';
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        state.liveLangInFlight = false;
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
    titleEl.value = defaultRecordingTitle();
  }
}

function ensureAutoTitleFilled() {
  if (titleEl.value.trim()) return;
  titleEl.value = defaultRecordingTitle();
}

function defaultRecordingTitle() {
  return `Recording_${timestampTag()}`;
}

// (Removed auto-incrementing Recording counter; titles are timestamp-based now.)

