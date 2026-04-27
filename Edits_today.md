---
title: voiceVault — Edits Today
date: 2026-04-26
---

## Summary

This document captures the key changes made on 2026-04-26.

## Search + retrieval UI

- **Advanced search panel**
  - Added an **Advanced search** collapsible panel.
  - Semantic mode is enabled/disabled via **Advanced search Show/Hide** (semantic toggle is hidden).
- **Semantic search bug fix**
  - Fixed a semantic filter bug where `duration_max_ms: null` was interpreted as 0, causing semantic search to return empty results.
- **Quick answer (top clips) behavior**
  - Quick answer clips are now **shown only when the user presses “Quick answer”** (not automatically on every search).
  - Quick answer is **offline/extractive** using top timestamped matches from the current result set.
- **Ask mode styling**
  - Updated Ask mode dropdown base styling (non-hover): black text on white background.

## Processes / ingestion improvements

- **Per-note processing controls**
  - Pause/resume processing per note and set priority for queued jobs.
  - Worker dequeues higher priority first and skips paused notes.
- **Job event timeline**
  - Added `job_events` table and event logging for queue/run/done/error/retry/cancel/unlock.
  - Job details modal now includes a timeline fetched from `/api/jobs/:id/events`.

## Notes / library metadata UX

- **Folder dropdown hiding**
  - When no folders exist, the folder dropdown in note cards is hidden so “No folder” is not shown.

## Layout defaults

- **Left pane defaults**
  - On load, **New note / Processes / Help start collapsed**.
  - Opening a pane restores the 50/50 split; collapsing widens Search.

