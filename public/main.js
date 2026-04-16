const statusEl = document.getElementById('status');
const btnRecordNote = document.getElementById('btnRecordNote');
const btnStopNote = document.getElementById('btnStopNote');
const btnSaveNote = document.getElementById('btnSaveNote');
const previewNote = document.getElementById('previewNote');
const titleEl = document.getElementById('title');

const qEl = document.getElementById('q');
const btnSearch = document.getElementById('btnSearch');
const btnRecordQuery = document.getElementById('btnRecordQuery');
const btnStopQuery = document.getElementById('btnStopQuery');
const previewQuery = document.getElementById('previewQuery');
const resultsEl = document.getElementById('results');

let note = makeRecorderState();
let query = makeRecorderState();

setStatus('Ready');
wire();
await refreshResults();

function wire() {
  btnRecordNote.addEventListener('click', () =>
    startRecording(note, {
      onUi: (s) => {
        btnRecordNote.disabled = s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        btnSaveNote.disabled = !s.hasAudio || s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
      },
      label: 'note'
    })
  );
  btnStopNote.addEventListener('click', () =>
    stopRecording(note, {
      onUi: (s) => {
        btnRecordNote.disabled = s.isRecording;
        btnStopNote.disabled = !s.isRecording;
        btnSaveNote.disabled = !s.hasAudio || s.isRecording;
        previewNote.hidden = !s.previewUrl;
        if (s.previewUrl) previewNote.src = s.previewUrl;
      }
    })
  );
  btnSaveNote.addEventListener('click', saveNote);

  btnRecordQuery.addEventListener('click', () =>
    startRecording(query, {
      onUi: (s) => {
        btnRecordQuery.disabled = s.isRecording;
        btnStopQuery.disabled = !s.isRecording;
        btnSearch.disabled = !s.hasAudio || s.isRecording;
        previewQuery.hidden = !s.previewUrl;
        if (s.previewUrl) previewQuery.src = s.previewUrl;
      },
      label: 'search'
    })
  );
  btnStopQuery.addEventListener('click', () =>
    stopRecording(query, {
      onUi: (s) => {
        btnRecordQuery.disabled = s.isRecording;
        btnStopQuery.disabled = !s.isRecording;
        btnSearch.disabled = (qEl.value.trim().length === 0 && !s.hasAudio) || s.isRecording;
        previewQuery.hidden = !s.previewUrl;
        if (s.previewUrl) previewQuery.src = s.previewUrl;
      }
    })
  );
  btnSearch.addEventListener('click', runAudioSearch);

  qEl.addEventListener('input', () => {
    if (query.isRecording) return;
    btnSearch.disabled = qEl.value.trim().length === 0 && !query.audioBlob;
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
    state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    state.chunks = [];
    state.audioBlob = null;
    state.previewUrl = '';
    state.isRecording = true;
    onUi?.(uiState(state));

    state.mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    });
    state.mediaRecorder.addEventListener('stop', () => {
      const type = state.mediaRecorder?.mimeType || mimeType || 'audio/webm';
      state.audioBlob = new Blob(state.chunks, { type });
      state.previewUrl = URL.createObjectURL(state.audioBlob);
      state.isRecording = false;
      onUi?.(uiState(state));
      setStatus(
        `Recorded ${label}: ${(state.audioBlob.size / 1024 / 1024).toFixed(2)} MB`
      );
    });

    state.mediaRecorder.start();
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
    onUi?.(uiState(state));
  }
}

async function saveNote() {
  if (!note.audioBlob) return;
  btnSaveNote.disabled = true;
  setStatus('Saving + transcribing…');

  try {
    const fd = new FormData();
    fd.append('title', titleEl.value || '');
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

    const t = (data?.transcript ?? '').toString().trim();
    setStatus(t ? `Saved. Transcript: "${t.slice(0, 80)}"` : 'Saved');
    await refreshResults(qEl.value);
  } catch (err) {
    setStatus(`Save/transcribe error: ${err?.message ?? err}`, true);
    btnSaveNote.disabled = false;
  }
}

async function refreshResults(q = '') {
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
    note.className = 'note';

    const created = new Date(item.created_at).toLocaleString();
    const title = escapeHtml(item.title || 'Untitled');
    const body = escapeHtml(item.body || '');

    note.innerHTML = `
      <div class="noteTitleRow">
        <div class="noteTitle">${title}</div>
        <div class="noteMeta">${created}</div>
      </div>
      <div class="noteBody">${body}</div>
      <div class="noteActions">
        <button class="btn" data-play="${item.id}">Play</button>
        <span class="pill">${escapeHtml(item.id)}</span>
      </div>
      <audio class="audio" controls hidden></audio>
    `;

    const btn = note.querySelector('button[data-play]');
    const audio = note.querySelector('audio');
    btn.addEventListener('click', async () => {
      audio.hidden = false;
      audio.src = `/api/notes/${encodeURIComponent(item.id)}/audio`;
      try {
        await audio.play();
      } catch {
        // ignore autoplay restrictions
      }
    });

    resultsEl.appendChild(note);
  }
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
  statusEl.className = `status${isError ? ' err' : ''}`;
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function guessFilename(mime) {
  if (mime?.includes('ogg')) return 'note.ogg';
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
    isRecording: false
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
  state.previewUrl = '';
  state.isRecording = false;
}

function uiState(state) {
  return {
    isRecording: !!state.isRecording,
    hasAudio: !!state.audioBlob,
    previewUrl: state.previewUrl || ''
  };
}

