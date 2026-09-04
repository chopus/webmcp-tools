/**
 * WebMCP Tools — native messaging port to the local relay/hub.
 *
 * Connects to the "com.webmcp.tools.host" native host (spawned by Chrome),
 * keeps the port open (which keeps the MV3 service worker alive — requires
 * Chrome >= 116), reconnects with backoff when the host/server dies, and
 * sends the `extensionHello` event on every (re)connect per PROTOCOL.md.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const HOST_NAME = 'com.webmcp.tools.host';
  const BACKOFF_SCHEDULE = [1000, 2000, 5000, 10000, 20000, 30000];
  const STABLE_AFTER_MS = 5000; // connection considered healthy after this long

  let port = null;
  let backoffIdx = 0;
  let reconnectTimer = null;
  let stableTimer = null;
  let requestHandler = null;
  let eventListener = null;
  const pendingResponses = new Map(); // id -> finish(ok, payload)

  function post(obj) {
    try {
      if (port) port.postMessage(obj);
    } catch (e) {
      /* port died mid-post; onDisconnect will trigger reconnect */
    }
  }

  async function helloData() {
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
      extensionVersion,
      chromeVersion,
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || ''
    };
  }

  function onConnected() {
    backoffIdx = 0;
    // Mark the connection stable after a short delay so immediate-failure
    // reconnects still back off (reset happens on first message too).
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { backoffIdx = 0; }, STABLE_AFTER_MS);
    helloData().then((data) => {
      post({ v: 1, kind: 'event', event: 'extensionHello', data });
    }).catch(() => { /* never throw */ });
  }

  function onDisconnected() {
    const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'unknown';
    console.warn('[webmcp] native port disconnected:', reason);
    port = null;
    clearTimeout(stableTimer);
    for (const finish of pendingResponses.values()) {
      try { finish(false, { message: 'native host connection lost', code: 'EWEBMCP' }); } catch (e) { /* noop */ }
    }
    pendingResponses.clear();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = BACKOFF_SCHEDULE[Math.min(backoffIdx, BACKOFF_SCHEDULE.length - 1)];
    backoffIdx = Math.min(backoffIdx + 1, BACKOFF_SCHEDULE.length - 1);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      if (port) {
        try { port.disconnect(); } catch (e) { /* noop */ }
        port = null;
      }
      const p = chrome.runtime.connectNative(HOST_NAME);
      port = p;
      p.onMessage.addListener(onMessage);
      p.onDisconnect.addListener(onDisconnected);
      console.log('[webmcp] connectNative(', HOST_NAME, ') issued');
      onConnected();
    } catch (e) {
      port = null;
      scheduleReconnect();
    }
  }

  function onMessage(msg) {
    try {
      backoffIdx = 0; // any traffic proves the pipe is alive
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'request' && (typeof msg.id === 'number')) {
        handleRequest(msg);
      } else if (msg.kind === 'hello' || msg.kind === 'event') {
        // Relay/hub lifecycle chatter — informational only.
        if (eventListener) {
          try { eventListener(msg); } catch (e) { /* listener error is not ours */ }
        }
      }
    } catch (e) {
      /* never throw into the port callback */
    }
  }

  async function handleRequest(req) {
    const id = req.id;
    let responded = false;
    const finish = (ok, payload) => {
      if (responded) return;
      responded = true;
      pendingResponses.delete(id);
      const msg = { v: 1, kind: 'response', id, ok };
      if (ok) {
        msg.result = payload === undefined ? null : payload;
      } else {
        msg.error = {
          message: payload && payload.message ? String(payload.message) : String(payload),
          code: payload && payload.code ? payload.code : 'EEXECUTION'
        };
      }
      post(msg);
    };
    pendingResponses.set(id, finish);
    try {
      if (typeof requestHandler !== 'function') {
        throw NS.util.err('request router is not installed', 'EWEBMCP');
      }
      const result = await requestHandler(req.tool, req.params || {}, finish);
      finish(true, result === undefined ? null : result);
    } catch (e) {
      finish(false, {
        message: e && e.message ? String(e.message) : String(e),
        code: e && e.code ? e.code : 'EEXECUTION'
      });
    }
  }

  NS.nativePort = {
    connect,
    disconnect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (port) {
        try { port.disconnect(); } catch (e) { /* noop */ }
        port = null;
      }
    },
    isConnected() {
      return !!port;
    },
    /** Register the dispatcher for `{kind:"request"}` messages. */
    onRequest(handler) {
      requestHandler = handler;
    },
    /** Manual/late response for a request id (must not already be answered). */
    respond(id, ok, payload) {
      const finish = pendingResponses.get(id);
      if (finish) finish(!!ok, payload);
    },
    /** Free-form event to the hub (e.g. diagnostics). */
    sendEvent(event, data) {
      post({ v: 1, kind: 'event', event, data });
    },
    onHubEvent(listener) {
      eventListener = listener;
    }
  };
})(self);
