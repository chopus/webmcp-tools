/**
 * WebMCP Tools — download tracking via chrome.downloads.
 *
 * onCreated / onChanged listeners keep an in-memory ring buffer (max 500,
 * insertion order) of download records; list_downloads reads it back,
 * newest first, with optional state filtering.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  const MAX_TRACKED = 500;
  const VALID_STATES = ['in_progress', 'complete', 'interrupted'];

  // id -> record (Map preserves insertion order = ring buffer discipline)
  const items = new Map();

  function ts(value) {
    if (typeof value !== 'string' || !value) return 0;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  function bytes(dl) {
    if (typeof dl.fileSize === 'number' && dl.fileSize > 0) return dl.fileSize;
    if (typeof dl.totalBytes === 'number' && dl.totalBytes > 0) return dl.totalBytes;
    return 0;
  }

  function recordFrom(dl) {
    return {
      id: dl.id,
      state: dl.state || 'in_progress',
      url: dl.url || '',
      finalUrl: dl.finalUrl || dl.url || '',
      filename: dl.filename || '',
      bytes: bytes(dl),
      startTime: ts(dl.startTime),
      endTime: ts(dl.endTime)
    };
  }

  function trim() {
    while (items.size > MAX_TRACKED) {
      items.delete(items.keys().next().value);
    }
  }

  chrome.downloads.onCreated.addListener((dl) => {
    try {
      if (!dl || typeof dl.id !== 'number') return;
      items.set(dl.id, recordFrom(dl));
      trim();
    } catch (e) {
      /* listeners must never throw */
    }
  });

  chrome.downloads.onChanged.addListener((delta) => {
    try {
      if (!delta || typeof delta.id !== 'number') return;
      let rec = items.get(delta.id);
      if (!rec) {
        // Missed the onCreated (worker was asleep) — minimal placeholder.
        rec = {
          id: delta.id, state: 'in_progress', url: '', finalUrl: '',
          filename: '', bytes: 0, startTime: Date.now(), endTime: undefined
        };
        items.set(delta.id, rec);
        trim();
      }
      if (delta.state && delta.state.current) rec.state = delta.state.current;
      if (delta.endTime && delta.endTime.current) {
        rec.endTime = ts(delta.endTime.current);
      }
      if (delta.filename && delta.filename.current) {
        rec.filename = delta.filename.current;
      }
      if (delta.fileSize && typeof delta.fileSize.current === 'number') {
        rec.bytes = delta.fileSize.current;
      }
    } catch (e) {
      /* listeners must never throw */
    }
  });

  /**
   * list_downloads: { lastN?=20, state?:"in_progress"|"complete"|"interrupted" }
   * -> { downloads: [...] } newest first.
   */
  function list(params) {
    const p = params || {};
    const lastN = Math.max(1, U.optInt(p, 'lastN', 20));
    let state = null;
    if (p.state !== undefined && p.state !== null) {
      if (VALID_STATES.indexOf(p.state) < 0) {
        throw U.err(
          `state must be one of ${VALID_STATES.join('|')}`,
          'EARGS'
        );
      }
      state = p.state;
    }
    const all = Array.from(items.values());
    all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    const out = [];
    for (const it of all) {
      if (state && it.state !== state) continue;
      if (out.length >= lastN) break;
      out.push(it);
    }
    return { downloads: out };
  }

  NS.downloads = { list };
})(self);
