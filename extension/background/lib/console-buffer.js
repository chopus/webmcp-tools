/**
 * WebMCP Tools — per-tab console log ring buffer (1000 entries) in the
 * service worker. Fed by content-script console captures, cleared when a
 * navigation commits or the tab goes away. Implements get_console_logs.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  const MAX_PER_TAB = 1000;
  const LEVELS = ['error', 'warn', 'log', 'info', 'debug'];
  const buffers = new Map(); // tabId -> [{ts, level, text}]

  function push(tabId, entry) {
    let b = buffers.get(tabId);
    if (!b) {
      b = [];
      buffers.set(tabId, b);
    }
    b.push(entry);
    if (b.length > MAX_PER_TAB) b.splice(0, b.length - MAX_PER_TAB);
  }

  function clear(tabId) {
    buffers.delete(tabId);
  }

  // Fed by the content script (single entries or small batches).
  chrome.runtime.onMessage.addListener((msg, sender) => {
    try {
      if (!msg || typeof msg !== 'object') return;
      const tabId = sender && sender.tab && sender.tab.id;
      if (typeof tabId !== 'number') return;
      if (msg.type === 'console') {
        push(tabId, {
          ts: Date.now(),
          level: LEVELS.indexOf(String(msg.level)) >= 0 ? String(msg.level) : 'log',
          text: msg.text === undefined || msg.text === null ? '' : String(msg.text)
        });
      } else if (msg.type === 'console_batch' && Array.isArray(msg.entries)) {
        for (const e of msg.entries) {
          if (!e || typeof e !== 'object') continue;
          push(tabId, {
            ts: typeof e.ts === 'number' ? e.ts : Date.now(),
            level: LEVELS.indexOf(String(e.level)) >= 0 ? String(e.level) : 'log',
            text: e.text === undefined || e.text === null ? '' : String(e.text)
          });
        }
      }
    } catch (e) {
      /* logs must never break the worker */
    }
    // Intentionally no sendResponse — fire-and-forget from the page.
  });

  // A committing navigation wipes the buffer for that tab.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && (changeInfo.url !== undefined || changeInfo.status === 'loading')) {
      clear(tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => clear(tabId));

  /** get_console_logs(tab, {levels?, lastN?}) -> { logs: [{ts, tabId, level, text}] } */
  function getLogs(tab, params) {
    const levels = U.optStrArray(params, 'levels', LEVELS);
    const allowed = new Set(levels.length ? levels : LEVELS);
    const lastN = Math.max(1, U.optInt(params, 'lastN', 200));
    const b = buffers.get(tab.id) || [];
    const out = [];
    for (let i = b.length - 1; i >= 0 && out.length < lastN; i--) {
      const e = b[i];
      if (allowed.has(e.level)) out.push({ ts: e.ts, tabId: tab.id, level: e.level, text: e.text });
    }
    return { logs: out.reverse() };
  }

  NS.consoleBuffer = {
    getLogs,
    clear
  };
})(self);
