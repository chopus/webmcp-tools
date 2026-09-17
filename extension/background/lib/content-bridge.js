/**
 * WebMCP Tools — bridge between the service worker and the content script.
 *
 * The content script is declared in the manifest (document_start, all frames)
 * but may be missing in tabs that predate extension install/update;
 * `ensureInjected` re-injects it with chrome.scripting in that case. The
 * content script detects double injection via a window flag, so re-injection
 * never clobbers the existing ref registry.
 *
 * Cross-frame support: rawSendFrame targets one frame; askFrames retries a
 * not-found element in every other frame; combinedSnapshot queries all frames
 * and renumbers refs into one global space (frameMaps translates global refs
 * back to {frameId, localRef} for interactions).
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  const CONTENT_FILES = ['content/content.js'];
  const CONSOLE_HOOK_FILES = ['lib/console-hook.js'];

  // Tabs where the MAIN-world console hook was requested this document.
  // Wrapping console makes Chrome attribute page console calls to this
  // extension's error log, so the hook must exist ONLY on agent-driven tabs
  // — never on pages the user browses passively.
  const hookRequested = new Set();

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && (changeInfo.url !== undefined || changeInfo.status === 'loading')) {
      hookRequested.delete(tabId); // new document: hook must be reinstalled
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => hookRequested.delete(tabId));

  /** Install the MAIN-world console hook once per tab document (best effort). */
  function ensureConsoleHook(tabId) {
    if (hookRequested.has(tabId)) return;
    hookRequested.add(tabId);
    injectConsoleHook(tabId);
  }

  /** Fire-and-forget MAIN-world console hook (page CSP does not apply). */
  function injectConsoleHook(tabId) {
    try {
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: CONSOLE_HOOK_FILES,
        world: 'MAIN',
        injectImmediately: true
      }, (results) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          console.warn('[webmcp] console hook injection failed:', lastErr.message);
        } else {
          console.log('[webmcp] console hook injected into tab', tabId);
        }
      });
    } catch (e) {
      console.warn('[webmcp] console hook injection threw:', e && e.message);
    }
  }

  function rawSend(tabId, message) {
    return rawSendFrame(tabId, 0, message);
  }

  function rawSendFrame(tabId, frameId, message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.tabs.sendMessage(tabId, message, { frameId }, (res) => {
          if (settled) return;
          settled = true;
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            const text = lastErr.message || '';
            const e = new Error(text || 'could not establish connection');
            e.noReceiver = /could not establish connection|receiving end does not exist/i.test(text);
            reject(e);
          } else {
            resolve(res);
          }
        });
      } catch (e) {
        if (!settled) { settled = true; reject(e); }
      }
    });
  }

  function unwrap(res) {
    if (!res || typeof res !== 'object') {
      throw U.err('content script returned an invalid response', 'EEXECUTION');
    }
    if (res.ok === false) {
      throw U.err(res.message || 'content script error', res.code || 'EEXECUTION');
    }
    return res;
  }

  async function ping(tabId) {
    return rawSend(tabId, { type: 'ping' });
  }

  /** Make sure the content script is alive in the tab's main frame. */
  async function ensureInjected(tabId) {
    ensureConsoleHook(tabId);
    try {
      await ping(tabId);
      return;
    } catch (e) {
      if (!e.noReceiver) throw e;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: CONTENT_FILES,
        injectImmediately: true
      });
    } catch (e) {
      throw U.err(
        `cannot inject content script into tab ${tabId} (${(e && e.message) || e}); ` +
        'the page may restrict extensions',
        'EEXECUTION'
      );
    }
    for (let i = 0; i < 20; i++) {
      await U.sleep(50);
      try {
        await ping(tabId);
        return;
      } catch (e) {
        if (!e.noReceiver) throw e;
      }
    }
    throw U.err('content script did not come up after injection', 'EEXECUTION');
  }

  /**
   * Send `{type:"<op>", ...}` to the tab's content script and resolve with the
   * `{ok:true, ...}` payload. On "could not establish connection", injects the
   * content script once and retries before giving up. A successful contact
   * marks the tab as agent-driven, which installs the console hook.
   */
  async function askTab(tabId, message) {
    try {
      const res = await rawSend(tabId, message);
      ensureConsoleHook(tabId);
      return unwrap(res);
    } catch (e) {
      if (!e || !e.noReceiver) throw e;
      await ensureInjected(tabId);
      return unwrap(await rawSend(tabId, message));
    }
  }

  // ---- cross-frame (iframes) --------------------------------------------------
  //
  // The content script runs in every frame (manifest all_frames). Global
  // snapshot refs are renumbered per frame (combinedSnapshot below) and this
  // mapping translates them back to {frameId, localRef} for interactions.

  // tabId -> [{ frameId, base, localRefs: [localRef, ...] }]
  const frameMaps = new Map();
  chrome.tabs.onRemoved.addListener((tabId) => frameMaps.delete(tabId));

  const NOT_FOUND_CODES = ['ENO_SUCH_REF', 'ENO_SUCH_SELECTOR'];

  function isNotFound(e) {
    return !!e && NOT_FOUND_CODES.indexOf(e.code) >= 0;
  }

  async function listFrames(tabId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return Array.isArray(frames) ? frames : [];
    } catch (e) {
      return [];
    }
  }

  /** Frames in query order: main frame (0) first, then every other frame. */
  async function framesMainFirst(tabId) {
    const frames = await listFrames(tabId);
    if (!frames.length) return [{ frameId: 0 }];
    const main = frames.filter((f) => f.frameId === 0);
    const rest = frames.filter((f) => f.frameId !== 0);
    return main.concat(rest);
  }

  /** askTab for a specific frame (injection fallback applies to frame 0). */
  async function askFrame(tabId, frameId, message) {
    if (frameId === 0) return askTab(tabId, message);
    return unwrap(await rawSendFrame(tabId, frameId, message));
  }

  /**
   * Try the main frame first; when it reports element-not-found, retry the
   * message in each other frame until one finds the element. Frames without
   * a reachable content script are skipped.
   */
  async function askFrames(tabId, message) {
    let firstError = null;
    try {
      return await askTab(tabId, message);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      firstError = e;
    }
    const frames = await listFrames(tabId);
    for (const f of frames) {
      if (f.frameId === 0) continue;
      let res;
      try {
        res = await rawSendFrame(tabId, f.frameId, message);
      } catch (e) {
        if (e && e.noReceiver) continue; // no content script in that frame
        throw e;
      }
      try {
        return unwrap(res);
      } catch (e) {
        if (isNotFound(e)) continue; // this frame doesn't know the element either
        throw e;
      }
    }
    throw firstError; // the main frame's not-found stands
  }

  /**
   * Frame-aware send for a message that targets an element ({ref}|{selector}
   * from automation.pickTarget). Global refs translate through the snapshot
   * frame map; on a mapping miss or a stale translation the main frame runs
   * first (back-compat), then every other frame on element-not-found.
   */
  async function askTargeted(tabId, message, target) {
    if (target && target.ref !== undefined && target.ref !== null) {
      const loc = translateRef(tabId, target.ref);
      if (loc) {
        try {
          return await askFrame(
            tabId, loc.frameId, Object.assign({}, message, { ref: loc.localRef })
          );
        } catch (e) {
          if (!isNotFound(e)) throw e;
          // stale translation — fall through to the frame scan
        }
      }
      return askFrames(tabId, Object.assign({}, message, { ref: target.ref }));
    }
    if (target && target.selector !== undefined && target.selector !== null) {
      return askFrames(tabId, Object.assign({}, message, { selector: target.selector }));
    }
    return askTab(tabId, message);
  }

  /** Global snapshot ref -> {frameId, localRef}, or null on a mapping miss. */
  function translateRef(tabId, ref) {
    const map = frameMaps.get(tabId);
    if (!map || typeof ref !== 'number' || !Number.isInteger(ref)) return null;
    for (const fm of map) {
      const idx = ref - fm.base - 1;
      if (idx >= 0 && idx < fm.localRefs.length) {
        return { frameId: fm.frameId, localRef: fm.localRefs[idx] };
      }
    }
    return null;
  }

  /**
   * Snapshot every frame and renumber refs into one global space: frame i's
   * element j (in snapshot order) gets global ref base_i + j + 1, where base
   * is the cumulative element count of the preceding frames. The per-tab
   * mapping stored in frameMaps translates global refs back to
   * {frameId, localRef} for interactions. Per-frame rect coordinates are kept
   * as-is; `truncated` is true when any frame truncated (or the combined cap
   * was hit).
   */
  async function combinedSnapshot(tabId, message) {
    const frames = await framesMainFirst(tabId);
    const maxElements = Math.max(1, message.maxElements || 800);
    const perFrame = [];
    let main = null;
    let total = 0;
    let truncated = false;

    for (const f of frames) {
      const remaining = maxElements - total;
      if (remaining <= 0) { truncated = true; break; }
      let res = null;
      if (f.frameId === 0) {
        res = await askTab(tabId, Object.assign({}, message, { maxElements: remaining }));
        main = res;
      } else {
        try {
          res = unwrap(await rawSendFrame(
            tabId, f.frameId, Object.assign({}, message, { maxElements: remaining })
          ));
        } catch (e) {
          continue; // unreachable/erroring child frames are skipped
        }
      }
      const elements = (res && Array.isArray(res.elements)) ? res.elements : [];
      let take = elements;
      let frameTruncated = !!(res && res.truncated);
      if (elements.length > remaining) {
        take = elements.slice(0, remaining);
        frameTruncated = true;
      }
      perFrame.push({ frameId: f.frameId, elements: take });
      total += take.length;
      truncated = truncated || frameTruncated;
    }

    // Renumber to global refs and record the frame mapping.
    const combined = [];
    const map = [];
    let base = 0;
    for (const pf of perFrame) {
      const localRefs = [];
      for (let j = 0; j < pf.elements.length; j++) {
        localRefs.push(pf.elements[j].ref);
        pf.elements[j].ref = base + j + 1;
        combined.push(pf.elements[j]);
      }
      map.push({ frameId: pf.frameId, base, localRefs });
      base += pf.elements.length;
    }
    frameMaps.set(tabId, map);

    return Object.assign({}, main || {}, {
      elements: combined,
      truncated
    });
  }

  NS.contentBridge = {
    ensureInjected,
    askTab,
    askFrame,
    askFrames,
    askTargeted,
    translateRef,
    combinedSnapshot,
    isNotFound,
    ping,
    injectConsoleHook
  };
})(self);
