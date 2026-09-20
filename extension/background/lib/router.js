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
      const hasText = typeof params.text === 'string' && params.text.length > 0;
      const hasSel = typeof params.selector === 'string' && params.selector.length > 0;
      const networkIdle = U.optBool(params, 'networkIdle', false);
      if (hasText && hasSel) {
        throw U.err('provide either text or selector, not both', 'EARGS');
      }
      if (!networkIdle && !hasText && !hasSel) {
        throw U.err('one of text / selector / networkIdle:true is required', 'EARGS');
      }
      let state = null;
      if (params.state !== undefined && params.state !== null) {
        if (!hasSel) {
          throw U.err('"state" is only valid with a selector', 'EARGS');
        }
        if (['visible', 'hidden', 'enabled', 'disabled', 'editable'].indexOf(params.state) < 0) {
          throw U.err(
            '"state" must be one of visible|hidden|enabled|disabled|editable',
            'EARGS'
          );
        }
        state = params.state;
      }
      const timeoutMs = U.optInt(params, 'timeoutMs', 10000);
      const tab = await NS.tabs.resolveTab(params.tabId);

      if (networkIdle) {
        // Network-idle is observed from the service worker over CDP: the
        // in-flight request count must stay at 0 for idleMs within timeoutMs.
        const idleMs = Math.max(0, U.optInt(params, 'idleMs', 500));
        await NS.cdp.ensureCapture(tab.id);
        const deadline = Date.now() + Math.max(250, timeoutMs);
        let quietSince = null;
        let found = false;
        while (Date.now() < deadline) {
          if (NS.cdp.inFlightCount(tab.id) === 0) {
            if (quietSince === null) quietSince = Date.now();
            if (Date.now() - quietSince >= idleMs) { found = true; break; }
          } else {
            quietSince = null;
          }
          await U.sleep(Math.max(50, Math.min(100, idleMs)));
        }
        return {
          found,
          matched: found ? 'networkIdle' : 'none',
          tabId: tab.id,
          url: tab.url || '',
          title: tab.title || ''
        };
      }

      const msg = { type: 'wait_for', timeoutMs };
      if (hasText) msg.text = params.text;
      else msg.selector = params.selector;
      if (state) msg.state = state;
      const res = await NS.contentBridge.askTab(tab.id, msg);
      return {
        found: !!res.found,
        matched: res.found ? (state ? 'state' : (hasText ? 'text' : 'selector')) : 'none',
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
      // combinedSnapshot queries every frame and renumbers refs globally
      // (per-frame rects stay frame-relative; truncated if any frame was).
      const res = await NS.contentBridge.combinedSnapshot(tab.id, {
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
    upload_file: (params) => withTab(params, NS.automation.uploadFile),

    // ---- §5 JavaScript ------------------------------------------------------
    evaluate: (params) => withTab(params, NS.automation.evaluate),

    // ---- §6 Console / network -----------------------------------------------

    /**
     * Explicitly attach console capture to a tab (content script + MAIN-world
     * console hook). get_console_logs attaches on first read too, but only
     * from that moment on — this tool exists so the agent can opt a tab it
     * never drove (e.g. one the user already had open) into capture before
     * the interesting logs happen.
     */
    watch_console: (params) => withTab(params, async (tab) => {
      await NS.contentBridge.ensureInjected(tab.id);
      return {
        watched: true,
        tabId: tab.id,
        note: 'console capture is attached from now on; logs emitted before this call are not recoverable'
      };
    }),

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

    // ---- native dialogs (lib/dialogs.js) -------------------------------------

    get_dialog: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      const w = await NS.dialogs.ensureWatch(tab.id);
      return { watched: true, open: !!w.dialog, dialog: w.dialog || null };
    },

    handle_dialog: async (params) => {
      const tab = await NS.tabs.resolveTab(params.tabId);
      const accept = U.optBool(params, 'accept', true);
      const promptText = U.optStr(params, 'promptText', undefined);
      return NS.dialogs.handleDialog(tab.id, accept, promptText, params.autoDismiss);
    },

    // ---- downloads (lib/downloads.js) ----------------------------------------

    list_downloads: async (params) => NS.downloads.list(params || {}),

    // ---- origin policy (lib/policy.js) ---------------------------------------

    get_origin_policy: async () => {
      const policy = await NS.policy.getPolicy();
      return { policy };
    },

    set_origin_policy: async (params) => {
      const policy = await NS.policy.setPolicy(params || {});
      return { policy };
    },

    // ---- windows (chrome.windows) --------------------------------------------

    list_windows: async () => {
      const wins = await chrome.windows.getAll({ populate: false });
      return {
        windows: wins.map((w) => ({
          windowId: w.id,
          state: w.state || 'normal',
          width: typeof w.width === 'number' ? w.width : 0,
          height: typeof w.height === 'number' ? w.height : 0,
          left: typeof w.left === 'number' ? w.left : 0,
          top: typeof w.top === 'number' ? w.top : 0,
          focused: !!w.focused,
          incognito: !!w.incognito,
          type: w.type || 'normal'
        }))
      };
    },

    new_window: async (params) => {
      const url = U.optStr(params, 'url', 'about:blank');
      const create = { url };
      if (params.width !== undefined && params.width !== null) {
        create.width = Math.trunc(U.optInt(params, 'width', 800));
      }
      if (params.height !== undefined && params.height !== null) {
        create.height = Math.trunc(U.optInt(params, 'height', 600));
      }
      let w;
      try {
        w = await chrome.windows.create(create);
      } catch (e) {
        throw U.err(`cannot open window (${(e && e.message) || e})`, 'EEXECUTION');
      }
      return {
        windowId: w.id,
        state: w.state || 'normal',
        width: typeof w.width === 'number' ? w.width : 0,
        height: typeof w.height === 'number' ? w.height : 0
      };
    },

    resize_window: async (params) => {
      const v = params ? params.windowId : undefined;
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw U.err('missing required integer param "windowId"', 'EARGS');
      }
      const update = {};
      if (params.width !== undefined && params.width !== null) {
        update.width = Math.trunc(U.optInt(params, 'width', 0));
      }
      if (params.height !== undefined && params.height !== null) {
        update.height = Math.trunc(U.optInt(params, 'height', 0));
      }
      if (params.state !== undefined && params.state !== null) {
        if (['normal', 'maximized', 'minimized', 'fullscreen'].indexOf(params.state) < 0) {
          throw U.err(
            'state must be one of normal|maximized|minimized|fullscreen', 'EARGS'
          );
        }
        update.state = params.state;
      }
      if (!Object.keys(update).length) {
        throw U.err('one of width / height / state is required', 'EARGS');
      }
      let w;
      try {
        w = await chrome.windows.update(v, update);
      } catch (e) {
        void chrome.runtime.lastError;
        throw U.err(`cannot update window ${v} (${(e && e.message) || e})`, 'EEXECUTION');
      }
      return {
        windowId: w.id,
        width: typeof w.width === 'number' ? w.width : 0,
        height: typeof w.height === 'number' ? w.height : 0,
        state: w.state || 'normal'
      };
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

  // Origin-policy enforcement wraps dispatch (lib/policy.js is imported
  // before this file): ACTION tools check the target origin first.
  let routed = dispatch;
  if (NS.policy && typeof NS.policy.wrapDispatch === 'function') {
    routed = NS.policy.wrapDispatch(dispatch);
  }

  NS.router = { dispatch: routed, handlers };
})(self);
