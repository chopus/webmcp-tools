/**
 * WebMCP Tools — chrome.tabs helpers: tab resolution, `Tab` serialization
 * (PROTOCOL.md shape) and navigation-completion waiting.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  /** Serialize a chrome Tab into the PROTOCOL `Tab` object shape. */
  function serializeTab(t) {
    const out = {
      tabId: t.id,
      windowId: t.windowId,
      index: t.index,
      title: typeof t.title === 'string' ? t.title : '',
      url: typeof t.url === 'string' ? t.url : '',
      active: !!t.active,
      pinned: !!t.pinned,
      status: t.status === 'complete' ? 'complete' : 'loading'
    };
    if (t.favIconUrl) out.favIconUrl = t.favIconUrl;
    if (typeof t.audible === 'boolean') out.audible = t.audible;
    return out;
  }

  async function getTab(tabId) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (e) {
      throw U.err(`tab ${tabId} not found`, 'ETAB_NOT_FOUND');
    }
  }

  /**
   * Resolve the target tab for a request: an explicit tabId wins; otherwise
   * the active tab of the last-focused window; otherwise the most recently
   * active tab overall.
   */
  async function resolveTab(tabId) {
    if (tabId !== undefined && tabId !== null) {
      if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
        throw U.err('tabId must be an integer', 'EARGS');
      }
      return getTab(tabId);
    }
    let tabs = [];
    try { tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch (e) { /* noop */ }
    if (!tabs || !tabs.length) {
      try { tabs = await chrome.tabs.query({ active: true }); } catch (e) { /* noop */ }
    }
    if (!tabs || !tabs.length) {
      let all = [];
      try { all = await chrome.tabs.query({}); } catch (e) { /* noop */ }
      if (all && all.length) {
        tabs = [all.reduce((a, b) => ((b.lastAccessed || 0) >= (a.lastAccessed || 0) ? b : a), all[0])];
      }
    }
    if (!tabs || !tabs.length) {
      throw U.err('no target tab found (no active tab)', 'ETAB_NOT_FOUND');
    }
    return tabs[0];
  }

  /**
   * Wait until `tabId` reaches status "complete". Rejects with ETIMEOUT on
   * timeout and ETAB_NOT_FOUND if the tab is removed (or already gone).
   */
  function waitTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        finish(reject, U.err(`navigation timed out after ${timeoutMs}ms`, 'ETIMEOUT'));
      }, timeoutMs);
      const onUpdated = (updatedId, changeInfo, tab) => {
        if (updatedId !== tabId) return;
        if (changeInfo && changeInfo.status === 'complete') finish(resolve, { tab });
      };
      const onRemoved = (removedId) => {
        if (removedId === tabId) {
          finish(reject, U.err(`tab ${tabId} was closed during the operation`, 'ETAB_NOT_FOUND'));
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      // The tab may already be complete (or complete before events wire up).
      chrome.tabs.get(tabId).then((t) => {
        if (t && t.status === 'complete') finish(resolve, { tab: t });
      }).catch(() => {
        finish(reject, U.err(`tab ${tabId} not found`, 'ETAB_NOT_FOUND'));
      });
    });
  }

  /**
   * navigate / reload helper: perform the mutation, allow the "loading"
   * transition to start, then wait for completion.
   */
  async function navigateAndWait(tabId, mutate, timeoutMs) {
    await mutate();
    // Give the browser a beat to flip the tab to "loading" before the
    // already-complete fast-path in waitTabComplete can fire prematurely.
    await U.sleep(150);
    const { tab } = await waitTabComplete(tabId, Math.max(250, timeoutMs - 150));
    return { tabId, url: tab.url || '', title: tab.title || '' };
  }

  /**
   * go_back / go_forward: returns navigated:false when no history entry
   * produces a navigation within the grace window.
   */
  async function goDirection(tabId, direction, timeoutMs) {
    await getTab(tabId); // ETAB_NOT_FOUND early
    const GRACE_MS = 1200;
    const started = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve(v);
      };
      const onUpdated = (id, changeInfo) => {
        if (id !== tabId) return;
        if ((changeInfo && changeInfo.status === 'loading') || (changeInfo && changeInfo.url !== undefined)) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), GRACE_MS);
      chrome.tabs.onUpdated.addListener(onUpdated);
      try {
        if (direction === 'back') chrome.tabs.goBack(tabId);
        else chrome.tabs.goForward(tabId);
      } catch (e) {
        finish(false);
      }
    });
    if (!started) {
      const t = await getTab(tabId);
      return { tabId, url: t.url || '', title: t.title || '', navigated: false };
    }
    const { tab } = await waitTabComplete(tabId, timeoutMs);
    return { tabId, url: tab.url || '', title: tab.title || '' };
  }

  NS.tabs = {
    serializeTab,
    getTab,
    resolveTab,
    waitTabComplete,
    navigateAndWait,
    goDirection
  };
})(self);
