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
const fastModeEl = document.getElementById('fastMode');
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
const noteTranscriptHintEl = document.getElementById('noteTranscriptHint');

const AUDIO_BITS_PER_SECOND = 64_000; // 64 kbps Opus (WebM); adjust if you want higher quality
const MEDIARECORDER_TIMESLICE_MS = 100; // 0.1s chunks (recording only)
const LIVE_LANG_DETECT_INTERVAL_MS = 2000; // practical Whisper polling cadence
const LIVE_TRANSCRIBE_INTERVAL_MS = 3000; // live transcript preview cadence

let note = makeRecorderState();
let query = makeRecorderState();

// Keep UI stable across polling refreshes
const expandedNoteIds = new Set();

bootstrapAutoTitle();
noteTimerEl?.setAttribute('hidden', '');
queryTimerEl?.setAttribute('hidden', '');
noteDetectedLangEl?.setAttribute('hidden', '');
stopTimer(note, noteTimerEl);
stopTimer(query, queryTimerEl);
renderBitrateHint();
if (fastModeEl) fastModeEl.checked = true;

setStatus('Ready');
wire();
await refreshResults();
syncVisibility();
startProcessingTimers();

function wire() {
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
    if (fastModeEl) fastModeEl.checked = true;
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

  fastModeEl?.addEventListener('change', () => {
    if (note.isRecording) return;
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
      }
    })
  );
  btnSearch.addEventListener('click', runAudioSearch);

  qEl.addEventListener('input', () => {
    if (query.isRecording) return;
    const shouldHide = qEl.value.trim().length === 0 && !query.audioBlob;
    btnSearch.hidden = shouldHide;
    btnSearch.disabled = shouldHide;
  });
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
    fd.append('fast_mode', fastModeEl?.checked ? '1' : '0');
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
    if (fastModeEl) fastModeEl.checked = false;
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
  resultsEl.innerHTML = '';
  const url = new URL('/api/notes', window.location.origin);
  if (q && q.trim()) url.searchParams.set('q', q.trim());

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    resultsEl.innerHTML = `<div class="note err">Failed to load notes</div>`;
    return;
  }
  const data = await resp.json();
  const items = data.items ?? [];

  if (items.length === 0) {
    resultsEl.innerHTML = `<div class="note"><div class="pill">No results</div></div>`;
    return;
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
    const title = escapeHtml(item.title || 'Untitled');
    const body = escapeHtml(item.body || '');

    note.innerHTML = `
      <div class="noteSummary">
        <div class="noteTitleRow">
        <div class="noteTitle">${title}</div>
          <div class="noteMeta">${created}</div>
        </div>
        <div style="margin-top:6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
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
          ${status === 'ready' ? `<button class="btn" data-toggle="${item.id}">Expand</button>` : ''}
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

        <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap">
          <button class="btn" data-scroll-up="${item.id}">Scroll up</button>
          <button class="btn" data-scroll-down="${item.id}">Scroll down</button>
          <button class="btn" data-play="${item.id}">Play Audio</button>
          <button class="btn" data-dl-audio="${item.id}">Download Audio</button>
          <button class="btn" data-dl-text="${item.id}">Download Transcript</button>
          <button class="btn" data-edit="${item.id}">Edit</button>
          <button class="btn" data-delete="${item.id}">Delete Note</button>
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
    const details = note.querySelector('.noteDetails');
    const scrollHint = note.querySelector('.noteScrollHint');

    const btnToggle = note.querySelector('button[data-toggle]');
    if (btnToggle) {
      if (expandedNoteIds.has(item.id)) {
        details.hidden = false;
        note.classList.add('noteExpanded');
        note.classList.remove('noteCollapsed');
        btnToggle.textContent = 'Collapse';
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
      });
    }

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
        await audio.play();
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
    const btnDlAudio = note.querySelector('button[data-dl-audio]');
    const btnDlText = note.querySelector('button[data-dl-text]');
    const btnScrollUp = note.querySelector('button[data-scroll-up]');
    const btnScrollDown = note.querySelector('button[data-scroll-down]');
    const btnSave = note.querySelector('button[data-save]');
    const btnCancel = note.querySelector('button[data-cancel]');

    btnScrollUp?.addEventListener('click', (e) => {
      e.stopPropagation();
      transcriptBox?.scrollBy({ top: -220, behavior: 'smooth' });
    });

    btnScrollDown?.addEventListener('click', (e) => {
      e.stopPropagation();
      transcriptBox?.scrollBy({ top: 220, behavior: 'smooth' });
    });

    transcriptBox?.addEventListener('scroll', () => updateScrollHint(transcriptBox, scrollHint));
    updateScrollHint(transcriptBox, scrollHint);

    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      editBox.hidden = !editBox.hidden;
      editTitle.value = (item.title ?? '').toString();
      editBody.value = (item.body ?? '').toString();
    });

    btnCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      editBox.hidden = true;
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

async function transcribeFullPreview() {
  if (!note.audioBlob) return;
  if (!liveTranscriptEl) return;

  if (liveTranscriptWrapEl) liveTranscriptWrapEl.hidden = false;
  liveTranscriptEl.value = '';
  if (liveTxStatusEl) liveTxStatusEl.hidden = false;

  const fd = new FormData();
  fd.append('language', (noteLanguageEl?.value ?? '').toString());
  fd.append('fast_mode', fastModeEl?.checked ? '1' : '0');
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
  if (!noteTranscriptHintEl) return;
  noteTranscriptHintEl.innerHTML = `
    <div style="margin-top:10px">
      <div class="row" style="margin-bottom:0">
        <button class="btn" id="aboutToggle" type="button">App hint</button>
        <button class="btn" id="uiStepsToggle" type="button">UI steps</button>
      </div>

      <div id="aboutBox" style="margin-top:10px" hidden>
        <div>Audio is being recorded at <strong>${kbps} kbps</strong>.</div>
        <div style="margin-top:6px">Maximum audio length limit is <strong>around 100 minutes</strong>.</div>
        <div style="margin-top:6px">This app uses <strong>Whisper</strong> model for transcription.</div>
        <div style="margin-top:6px"><strong>Fast mode</strong> is enabled by default (faster, slightly lower accuracy).</div>
        <div style="margin-top:6px">
          When you save, voiceVault will <strong>transcribe offline</strong> and use the transcript for cross-note search.
        </div>
      </div>

      <div id="uiStepsBox" style="margin-top:10px" hidden>
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
          7) To find a note: use <strong>Record search</strong> → <strong>Stop</strong> → <strong>Search</strong> (or type in the box)
        </div>
        <div style="margin-top:4px">
          8) In results: use <strong>Expand</strong> to see full transcript + actions
        </div>
        <div style="margin-top:4px">
          9) In expanded notes: <strong>Play/Stop Audio</strong>, download audio/transcript, <strong>Edit</strong>, <strong>Delete Note</strong>
          (use scroll buttons to read long transcripts)
        </div>
      </div>
    </div>
  `;

  const aboutToggle = document.getElementById('aboutToggle');
  const aboutBox = document.getElementById('aboutBox');
  const toggle = document.getElementById('uiStepsToggle');
  const box = document.getElementById('uiStepsBox');
  if (aboutToggle && aboutBox) {
    aboutToggle.addEventListener('click', () => {
      const nextHidden = !aboutBox.hidden;
      aboutBox.hidden = nextHidden;
      aboutToggle.textContent = nextHidden ? 'App hint' : 'Hide App hint';

      // Only one open at a time
      if (!nextHidden && box && toggle) {
        box.hidden = true;
        toggle.textContent = 'UI steps';
      }
    });
  }
  if (toggle && box) {
    toggle.addEventListener('click', () => {
      const nextHidden = !box.hidden;
      box.hidden = nextHidden;
      toggle.textContent = nextHidden ? 'UI steps' : 'Hide UI steps';

      // Only one open at a time
      if (!nextHidden && aboutBox && aboutToggle) {
        aboutBox.hidden = true;
        aboutToggle.textContent = 'App hint';
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

