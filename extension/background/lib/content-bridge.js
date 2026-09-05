/**
 * WebMCP Tools — bridge between the service worker and the content script.
 *
 * The content script is declared in the manifest (document_start) but may be
 * missing in tabs that predate extension install/update; `ensureInjected`
 * re-injects it with chrome.scripting in that case. The content script
 * detects double injection via a window flag, so re-injection never clobbers
 * the existing ref registry.
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
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (res) => {
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

  NS.contentBridge = {
    ensureInjected,
    askTab,
    ping,
    injectConsoleHook
  };
})(self);
