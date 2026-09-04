/**
 * WebMCP Tools — chrome.debugger (CDP) wrapper.
 *
 * - withDebugger(tabId, fn): attach -> run -> detach, skipping the detach
 *   while a network capture owns the attachment.
 * - trustedInput: CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent /
 *   Input.insertText for real-input-level events.
 * - full-page screenshots via Page.captureScreenshot (captureBeyondViewport).
 * - network capture: Network.enable + ring buffer (500/tab) until
 *   stop_network_capture.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const U = NS.util;

  // tabId -> { capture: boolean, netEnabled: boolean }  (only for OUR attaches)
  const attached = new Map();

  // tabId -> { pending: Map<requestId, {ts, method, url}>, entries: [] }
  const captures = new Map();
  const MAX_NET_PER_TAB = 500;

  function attach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message || 'debugger attach failed'));
        else resolve();
      });
    });
  }

  function detach(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  /**
   * attach -> fn(command, state) -> detach (unless a network capture holds it).
   * `command(method, params)` returns a promise for the CDP result and
   * rejects with EDEBUGGER on failure.
   */
  async function withDebugger(tabId, fn) {
    let state = attached.get(tabId);
    if (!state) {
      try {
        await attach(tabId);
      } catch (e) {
        throw U.err(
          `debugger attach failed for tab ${tabId} (${(e && e.message) || e}); ` +
          'DevTools or another debugger may already be attached',
          'EDEBUGGER'
        );
      }
      state = { capture: false, netEnabled: false };
      attached.set(tabId, state);
    }
    const command = (method, params) => new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reject(U.err(`CDP ${method} failed: ${lastErr.message || 'unknown error'}`, 'EDEBUGGER'));
        } else {
          resolve(result);
        }
      });
    });
    try {
      return await fn(command, state);
    } finally {
      if (!state.capture) {
        attached.delete(tabId);
        await detach(tabId);
      }
    }
  }

  chrome.debugger.onDetach.addListener((source) => {
    if (source && typeof source.tabId === 'number') {
      attached.delete(source.tabId);
      captures.delete(source.tabId);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
    captures.delete(tabId);
  });

  // ---- trusted input -------------------------------------------------------

  function modBits(modifiers) {
    let bits = 0;
    for (const raw of modifiers || []) {
      const m = String(raw || '').toLowerCase();
      if (m === 'alt' || m === 'option') bits |= 1;
      else if (m === 'control' || m === 'ctrl') bits |= 2;
      else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'windows') bits |= 4;
      else if (m === 'shift') bits |= 8;
    }
    return bits;
  }

  const BUTTON_CDP = { left: 'left', middle: 'middle', right: 'right' };
  const BUTTON_MASK = { left: 1, middle: 4, right: 2 };

  /**
   * Trusted mouse click: mouseMoved -> mousePressed -> mouseReleased.
   * `loc` supplies viewport CSS coordinates (from the content script).
   */
  async function trustedClick(command, opts) {
    const button = BUTTON_CDP[opts.button] || 'left';
    const clickCount = Math.max(1, opts.clickCount || 1);
    const base = {
      x: opts.x,
      y: opts.y,
      button,
      buttons: BUTTON_MASK[button],
      clickCount,
      modifiers: modBits(opts.modifiers),
      pointerType: 'mouse'
    };
    await command('Input.dispatchMouseEvent', Object.assign({}, base, {
      type: 'mouseMoved', buttons: 0, clickCount: 0
    }));
    await command('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mousePressed' }));
    await command('Input.dispatchMouseEvent', Object.assign({}, base, { type: 'mouseReleased' }));
  }

  /** Trusted mouse move (hover / drag steps). */
  async function trustedMouseMove(command, x, y, buttons) {
    await command('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'left', buttons: buttons || 0,
      clickCount: 0, modifiers: 0, pointerType: 'mouse'
    });
  }

  const MODIFIER_KEY_SPECS = {
    Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
    Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
    Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
    Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 }
  };

  async function dispatchKey(command, type, spec, modifiers, text) {
    const ev = {
      type,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      modifiers,
      location: 0,
      isKeypad: false
    };
    if (text) {
      ev.text = text;
      ev.unmodifiedText = text;
    }
    await command('Input.dispatchKeyEvent', ev);
  }

  /**
   * Trusted key press from a parsed combo (WMCP.util.parseKeyCombo), including
   * modifier transitions ("Control+A" presses/releases Control around the A).
   */
  async function trustedKeyCombo(command, combo) {
    let bits = 0;
    const pressed = [];
    for (const mod of combo.modifiers) {
      const spec = MODIFIER_KEY_SPECS[mod];
      if (!spec) continue;
      await dispatchKey(command, 'keyDown', spec, bits);
      bits |= U.MOD_BITS[mod];
      pressed.push(spec);
    }
    const base = { key: combo.key, code: combo.code, vk: combo.keyCode };
    if (combo.text) {
      await dispatchKey(command, 'keyDown', base, bits, combo.text);
    } else {
      await dispatchKey(command, 'keyDown', base, bits);
    }
    await dispatchKey(command, 'keyUp', base, bits);
    for (const spec of pressed.slice().reverse()) {
      const modName = Object.keys(MODIFIER_KEY_SPECS).find(
        (k) => MODIFIER_KEY_SPECS[k] === spec
      );
      bits &= ~U.MOD_BITS[modName];
      await dispatchKey(command, 'keyUp', spec, bits);
    }
  }

  /** Trusted text insertion (bypasses per-key layout, like real IME typing). */
  async function trustedType(command, text) {
    await command('Input.insertText', { text: String(text) });
  }

  // ---- full-page screenshot ------------------------------------------------

  async function captureFullPage(tabId, opts) {
    const format = opts.format === 'jpeg' ? 'jpeg' : 'png';
    const params = { format, captureBeyondViewport: true };
    if (format === 'jpeg') {
      params.quality = Math.min(100, Math.max(1, Math.round(opts.quality || 80)));
    }
    return withDebugger(tabId, async (command) => {
      const res = await command('Page.captureScreenshot', params);
      if (!res || !res.data) throw U.err('Page.captureScreenshot returned no data', 'EDEBUGGER');
      return { format, dataBase64: res.data };
    });
  }

  // ---- evaluate (CDP Runtime.evaluate — immune to page/extension CSP) ------
  //
  // chrome.scripting + `new Function` is blocked in ISOLATED worlds by the
  // extension's own MV3 CSP (no unsafe-eval) and in MAIN worlds by the page's
  // CSP. CDP Runtime.evaluate has no such restriction: the expression runs in
  // the page's main context (MAIN) or a freshly created isolated world
  // (ISOLATED — a clean JS environment sharing the same DOM).

  async function cdpEvaluate(tabId, expression, opts) {
    const o = opts || {};
    return withDebugger(tabId, async (command) => {
      let contextId;
      if (o.world === 'ISOLATED') {
        await command('Page.enable', {});
        const tree = await command('Page.getFrameTree', {});
        const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
        if (!frameId) {
          throw U.err('could not resolve the main frame for isolated-world evaluation', 'EDEBUGGER');
        }
        const world = await command('Page.createIsolatedWorld', {
          frameId,
          worldName: 'webmcp_evaluate'
        });
        contextId = world && world.executionContextId;
        if (!contextId) {
          throw U.err('Page.createIsolatedWorld failed', 'EDEBUGGER');
        }
      }
      const evalParams = {
        expression,
        awaitPromise: !!o.awaitPromise,
        returnByValue: true,
        userGesture: true
      };
      if (contextId) evalParams.contextId = contextId;
      return command('Runtime.evaluate', evalParams);
    });
  }

  // ---- network capture -----------------------------------------------------

  chrome.debugger.onEvent.addListener((source, method, params) => {
    try {
      if (!source || typeof source.tabId !== 'number') return;
      const cap = captures.get(source.tabId);
      if (!cap) return;
      if (method === 'Network.requestWillBeSent') {
        cap.pending.set(params.requestId, {
          ts: Date.now(),
          method: (params.request && params.request.method) || 'GET',
          url: (params.request && params.request.url) || ''
        });
      } else if (method === 'Network.responseReceived') {
        const pending = cap.pending.get(params.requestId);
        cap.pending.delete(params.requestId);
        cap.entries.push({
          ts: pending ? pending.ts : Date.now(),
          method: pending ? pending.method : 'GET',
          url: (params.response && params.response.url) || (pending ? pending.url : ''),
          status: (params.response && params.response.status) || 0,
          type: params.type || ''
        });
        if (cap.entries.length > MAX_NET_PER_TAB) {
          cap.entries.splice(0, cap.entries.length - MAX_NET_PER_TAB);
        }
      }
    } catch (e) {
      /* capture must never throw */
    }
  });

  /** Attach (or reuse) the debugger and enable Network tracking for a tab. */
  async function ensureCapture(tabId) {
    const existing = attached.get(tabId);
    if (existing) {
      existing.capture = true; // hold the attachment for the capture session
      if (!existing.netEnabled) {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
          existing.netEnabled = true;
        } catch (e) {
          void chrome.runtime.lastError;
          existing.capture = false;
          throw U.err(
            `Network.enable failed for tab ${tabId} (${(e && e.message) || e})`,
            'EDEBUGGER'
          );
        }
      }
    } else {
      await withDebugger(tabId, async (command, state) => {
        await command('Network.enable', {});
        state.netEnabled = true;
        state.capture = true;
      });
    }
    if (!captures.has(tabId)) {
      captures.set(tabId, { pending: new Map(), entries: [] });
    }
  }

  /** stop_network_capture: Network.disable + detach if we own the attachment. */
  async function stopCapture(tabId) {
    captures.delete(tabId);
    const state = attached.get(tabId);
    if (state) {
      state.capture = false;
      if (state.netEnabled) {
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Network.disable', {});
        } catch (e) {
          void chrome.runtime.lastError;
        }
        state.netEnabled = false;
      }
      attached.delete(tabId);
      await detach(tabId);
    }
    return { stopped: true };
  }

  function getRequests(tabId, params) {
    const cap = captures.get(tabId) || { entries: [] };
    const lastN = Math.max(1, U.optInt(params, 'lastN', 50));
    const urlContains = params && typeof params.urlContains === 'string' ? params.urlContains : null;
    const out = [];
    for (let i = cap.entries.length - 1; i >= 0 && out.length < lastN; i--) {
      const e = cap.entries[i];
      if (urlContains === null || e.url.indexOf(urlContains) !== -1) {
        out.push({ ts: e.ts, method: e.method, url: e.url, status: e.status, type: e.type });
      }
    }
    return { requests: out.reverse() };
  }

  NS.cdp = {
    withDebugger,
    trustedClick,
    trustedMouseMove,
    trustedKeyCombo,
    trustedType,
    captureFullPage,
    cdpEvaluate,
    ensureCapture,
    stopCapture,
    getRequests,
    modBits
  };
})(self);
