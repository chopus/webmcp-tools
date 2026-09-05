/**
 * WebMCP Tools — request router: tool name -> async handler(params).
 *
 * Every handler resolves the target tab (tabId omitted -> active tab of the
 * last-focused window), implements exactly one tool from PROTOCOL.md §1–§7,
 * and returns the plain result object. Dispatch wraps handlers so a thrown
 * error becomes { message, code } with a protocol error code — and every
 * request answers exactly once (native-port enforces that per id).
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  async function browserInfo() {
    let chromeVersion = '';
    try {
      if (typeof chrome.runtime.getBrowserInfo === 'function') {
        const info = await chrome.runtime.getBrowserInfo();
        if (info && info.version) chromeVersion = info.version;
      }
    } catch (e) { /* not chrome-branded */ }
    if (!chromeVersion) {
      const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent || '');
      chromeVersion = m ? m[1] : '';
    }
    let extensionVersion = '';
    try { extensionVersion = chrome.runtime.getManifest().version; } catch (e) { /* noop */ }
    return {
      chromeVersion,
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || '',
      extensionVersion
    };
  }

  function requiredTabId(params) {
    const v = params ? params.tabId : undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw U.err('missing required integer param "tabId"', 'EARGS');
    }
    return v;
  }

  const handlers = {
    // ---- §1 Browser / tabs --------------------------------------------------
    get_browser_info: () => browserInfo(),

    list_tabs: async () => {
      const all = await chrome.tabs.query({});
      return { tabs: all.map(NS.tabs.serializeTab) };
    },

    new_tab: async (params) => {
      const url = U.optStr(params, 'url', 'about:blank');
      const active = U.optBool(params, 'active', true);
      const create = { url, active };
      if (params.windowId !== undefined && params.windowId !== null) {
        if (typeof params.windowId !== 'number' || !Number.isInteger(params.windowId)) {
          throw U.err('windowId must be an integer', 'EARGS');
        }
        create.windowId = params.windowId;
      }
      let tab;
      try {
        tab = await chrome.tabs.create(create);
      } catch (e) {
        throw U.err(`cannot open url "${url}" (${(e && e.message) || e})`, 'ENAVIGATION');
      }
      return { tab: NS.tabs.serializeTab(tab) };
    },

    activate_tab: async (params) => {
      const tabId = requiredTabId(params);
      const tab = await NS.tabs.getTab(tabId);
      try {
        await chrome.tabs.update(tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        void chrome.runtime.lastError;
        throw U.err(`cannot activate tab ${tabId} (${(e && e.message) || e})`, 'ETAB_NOT_FOUND');
      }
      return { tab: NS.tabs.serializeTab(await NS.tabs.getTab(tabId)) };
    },

    close_tab: async (params) => {
      const tabId = requiredTabId(params);
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        void chrome.runtime.lastError;
        throw U.err(`cannot close tab ${tabId} (${(e && e.message) || e})`, 'ETAB_NOT_FOUND');
      }
      return { closed: true };
    },

    // ---- §2 Navigation ------------------------------------------------------
    navigate: async (params) => {
      const url = U.reqStr(params, 'url');
      const timeoutMs = U.optInt(params, 'timeoutMs', 30000);
      const tab = await NS.tabs.resolveTab(params.tabId);
      try {
        await chrome.tabs.update(tab.id, { url });
      } catch (e) {
        void chrome.runtime.lastError;
        throw U.err(`navigation to "${url}" failed (${(e && e.message) || e})`, 'ENAVIGATION');
      }
      return NS.tabs.navigateAndWait(tab.id, async () => {}, timeoutMs);
    },

    go_back: async (params) => {
      const timeoutMs = U.optInt(params, 'timeoutMs', 15000);
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.tabs.goDirection(tab.id, 'back', timeoutMs);
    },

    go_forward: async (params) => {
      const timeoutMs = U.optInt(params, 'timeoutMs', 15000);
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.tabs.goDirection(tab.id, 'forward', timeoutMs);
    },

    reload: async (params) => {
      const bypassCache = U.optBool(params, 'bypassCache', false);
      const timeoutMs = U.optInt(params, 'timeoutMs', 30000);
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.tabs.navigateAndWait(
        tab.id,
        () => chrome.tabs.reload(tab.id, { bypassCache }),
        timeoutMs
      );
    },

    wait_for: async (params) => {
      const which = U.reqOneOf(params, ['text', 'selector']);
      if (typeof params[which] !== 'string' || params[which].length === 0) {
        throw U.err(`"${which}" must be a non-empty string`, 'EARGS');
      }
      const timeoutMs = U.optInt(params, 'timeoutMs', 10000);
      const tab = await NS.tabs.resolveTab(params.tabId);
      const res = await NS.contentBridge.askTab(tab.id, {
        type: 'wait_for', [which]: params[which], timeoutMs
      });
      return {
        found: !!res.found,
        matched: res.found ? which : 'none',
        tabId: tab.id,
        url: res.url || '',
        title: res.title || ''
      };
    },

    // ---- §3 Observation -----------------------------------------------------
    snapshot: async (params) => {
      const maxElements = U.optInt(params, 'maxElements', 800);
      const viewportOnly = U.optBool(params, 'viewportOnly', false);
      const tab = await NS.tabs.resolveTab(params.tabId);
      const res = await NS.contentBridge.askTab(tab.id, {
        type: 'snapshot', maxElements, viewportOnly
      });
      return {
        tabId: tab.id,
        url: res.url || '',
        title: res.title || '',
        viewport: res.viewport,
        elements: res.elements || [],
        truncated: !!res.truncated
      };
    },

    get_page_text: async (params) => {
      const maxChars = U.optInt(params, 'maxChars', 20000);
      const tab = await NS.tabs.resolveTab(params.tabId);
      const res = await NS.contentBridge.askTab(tab.id, {
        type: 'get_page_text', maxChars
      });
      return {
        tabId: tab.id,
        url: res.url || '',
        title: res.title || '',
        text: res.text || '',
        truncated: !!res.truncated
      };
    },

    get_links: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      const res = await NS.contentBridge.askTab(tab.id, { type: 'get_links' });
      return { links: res.links || [] };
    },

    screenshot: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.screenshot.screenshot(tab, params);
    },

    // ---- §4 Interaction -----------------------------------------------------
    click: (params) => withTab(params, NS.automation.click),
    type_text: (params) => withTab(params, NS.automation.typeText),
    press_key: (params) => withTab(params, NS.automation.pressKey),
    hover: (params) => withTab(params, NS.automation.hover),
    scroll: (params) => withTab(params, NS.automation.scroll),
    select_option: (params) => withTab(params, NS.automation.selectOption),
    drag: (params) => withTab(params, NS.automation.drag),

    // ---- §5 JavaScript ------------------------------------------------------
    evaluate: (params) => withTab(params, NS.automation.evaluate),

    // ---- §6 Console / network -----------------------------------------------
    get_console_logs: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.consoleBuffer.getLogs(tab, params);
    },

    get_network_requests: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      await NS.cdp.ensureCapture(tab.id);
      return NS.cdp.getRequests(tab.id, params);
    },

    stop_network_capture: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.cdp.stopCapture(tab.id);
    },

    get_cookies: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      const url = typeof params.url === 'string' && params.url ? params.url : (tab.url || '');
      return NS.cdp.getCookies(tab.id, url);
    },

    // ---- §7 WebMCP ----------------------------------------------------------
    list_webmcp_tools: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.webmcp.listTools(tab, params);
    },

    call_webmcp_tool: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      return NS.webmcp.callTool(tab, params);
    }
  };

  function withTab(params, handler) {
    return NS.tabs.resolveTab(params ? params.tabId : undefined).then(
      (tab) => handler(tab, params || {})
    );
  }

  /** Route a `{v, kind:"request", tool, params}` to its handler. */
  async function dispatch(tool, params) {
    const handler = handlers[tool];
    if (typeof handler !== 'function') {
      throw U.err(`unknown tool "${tool}"`, 'EARGS');
    }
    return handler(params || {});
  }

  NS.router = { dispatch, handlers };
})(self);
