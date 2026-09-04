/**
 * WebMCP Tools — content script (classic IIFE, injected at document_start on
 * <all_urls> in the top frame only; also re-injectable by the service worker).
 *
 * Responsibilities:
 *  - console/error capture (rate-limited forward to the service worker)
 *  - element ref registry (stable per document, refs created lazily)
 *  - snapshot of interactive elements
 *  - get_page_text / get_links / wait_for / scroll
 *  - DOM-mode interactions: click, hover, type_text, press_key,
 *    select_option, drag (synthetic pointer/mouse/keyboard sequences)
 *  - `locate` for trusted (CDP) input coordinates
 *
 * Message protocol with the service worker: {type:"<op>", ...} ->
 * {ok:true, ...} | {ok:false, message, code}. Never throws into the page.
 */
(function () {
  'use strict';

  // Double-injection guard: the script is both manifest-declared and
  // programmatically injected; the second copy must not re-register anything
  // or clobber the ref registry.
  if (window.__webmcpToolsContent) return;
  window.__webmcpToolsContent = true;

  // ===========================================================================
  // error helper
  // ===========================================================================

  function fail(message, code) {
    const e = new Error(message);
    e.webmcpError = true;
    e.code = code || 'EEXECUTION';
    throw e;
  }

  // ===========================================================================
  // console capture (document_start) — rate limited to ~50 messages/s
  // ===========================================================================

  const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  const LOG_QUEUE_MAX = 2000;
  const LOG_RATE = 50;      // messages per second
  const LOG_BURST = 50;     // bucket size

  const logQueue = [];
  let logTokens = LOG_BURST;
  let logLastRefill = Date.now();

  function fmtValue(v, depth) {
    try {
      if (v === null) return 'null';
      if (v === undefined) return 'undefined';
      const t = typeof v;
      if (t === 'string') return depth === 0 ? v : JSON.stringify(v);
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
      if (t === 'function') return v.name ? `[function ${v.name}]` : '[function (anonymous)]';
      if (t === 'symbol') return v.toString();
      if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
      if (typeof Element !== 'undefined' && v instanceof Element) {
        return `<${v.tagName.toLowerCase()}${v.id ? '#' + v.id : ''}>`;
      }
      if (depth >= 3) return Array.isArray(v) ? '[…]' : '{…}';
      if (Array.isArray(v)) {
        const items = v.slice(0, 20).map((x) => fmtValue(x, depth + 1));
        return `[${items.join(', ')}${v.length > 20 ? ', …' : ''}]`;
      }
      const s = JSON.stringify(v);
      if (s === undefined) return String(v);
      return s.length > 500 ? s.slice(0, 500) + '…' : s;
    } catch (e) {
      return '[unserializable]';
    }
  }

  function fmtArgs(args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) parts.push(fmtValue(args[i], 0));
    let text = parts.join(' ');
    if (text.length > 2000) text = text.slice(0, 2000) + '…';
    return text;
  }

  function captureLog(level, args) {
    try {
      let text;
      try { text = fmtArgs(args); } catch (e) { text = '[unformattable log entry]'; }
      logQueue.push({ ts: Date.now(), level, text });
      if (logQueue.length > LOG_QUEUE_MAX) {
        logQueue.splice(0, logQueue.length - LOG_QUEUE_MAX);
      }
    } catch (e) { /* never break the page */ }
  }

  function flushLogs() {
    try {
      const now = Date.now();
      const elapsed = now - logLastRefill;
      if (elapsed > 0) {
        logTokens = Math.min(LOG_BURST, logTokens + (elapsed * LOG_RATE) / 1000);
        logLastRefill = now;
      }
      if (!logQueue.length || logTokens < 1) return;
      const n = Math.min(logQueue.length, Math.floor(logTokens), 20);
      logTokens -= n;
      const batch = logQueue.splice(0, n);
      for (const entry of batch) {
        try {
          chrome.runtime.sendMessage(
            { type: 'console', level: entry.level, text: entry.text },
            () => { void chrome.runtime.lastError; }
          );
        } catch (e) { /* worker may be gone */ }
      }
    } catch (e) { /* never break the page */ }
  }

  setInterval(flushLogs, 200);
  window.addEventListener('beforeunload', flushLogs);

  for (const level of CONSOLE_LEVELS) {
    try {
      const original = console[level];
      if (typeof original !== 'function') continue;
      console[level] = function (...args) {
        captureLog(level, args);
        try { original.apply(console, args); } catch (e) { /* noop */ }
      };
    } catch (e) { /* read-only console */ }
  }

  window.addEventListener('error', (event) => {
    try {
      if (event.target && event.target !== window && event.target.tagName) {        const el = event.target;
        const src = el.getAttribute && (el.getAttribute('src') || el.getAttribute('href')) || '';
        captureLog('error', [`${el.tagName}${src ? ' ' + src : ''} failed to load`]);
        return;
      }
      const where = event.filename ? ` @ ${event.filename}:${event.lineno || 0}` : '';
      captureLog('error', [`${event.message || 'script error'}${where}`]);
    } catch (e) { /* noop */ }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason;
      captureLog('error', [
        'Unhandled promise rejection: ' + (reason instanceof Error
          ? (reason.stack || `${reason.name}: ${reason.message}`)
          : fmtValue(reason, 1))
      ]);
    } catch (e) { /* noop */ }
  });

  // The wrapped console above lives in the ISOLATED world — page scripts log
  // through the MAIN world's console and never touch it. Forward MAIN-world
  // logs (from lib/console-hook.js, injected below and by the service worker)
  // into the same capture pipeline.
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      const d = event.data;
      if (d && d.__webmcpConsole === 1 && typeof d.level === 'string') {
        captureLog(d.level, [String(d.text)]);
        flushLogs(); // user-action logs reach the agent without the 200ms tick
      }
    } catch (e) { /* never break the page */ }
  });

  // Modern Chrome both (a) refuses to run script elements inserted from
  // isolated worlds and (b) logs a CSP violation for the attempt, so don't
  // inject an inline hook from here. Ask the service worker to inject
  // lib/console-hook.js with chrome.scripting (world: MAIN) instead — that
  // path is exempt from page CSP and verified working.
  try {
    chrome.runtime.sendMessage({ type: 'needConsoleHook' }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) { /* worker may be asleep */ }


  // ===========================================================================
  // ref registry — refs are stable for the document lifetime
  // ===========================================================================

  const refToElement = new Map();
  const elementToRef = new Map();
  let nextRef = 1; // monotonic, starts at 1, created lazily by snapshot/locate

  function refFor(el) {
    let ref = elementToRef.get(el);
    if (ref === undefined) {
      ref = nextRef++;
      elementToRef.set(el, ref);
      refToElement.set(ref, el);
    }
    return ref;
  }

  function resolveRef(ref) {
    if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1) {
      fail(`invalid ref ${ref}`, 'EARGS');
    }
    const el = refToElement.get(ref);
    if (!el) {
      fail(`ref ${ref} is not known in this document (take a new snapshot)`, 'ENO_SUCH_REF');
    }
    if (!el.isConnected) {
      fail(`ref ${ref} points to a detached element (take a new snapshot)`, 'ENO_SUCH_REF');
    }
    return el;
  }

  function resolveTarget(msg, refKey, selKey) {
    refKey = refKey || 'ref';
    selKey = selKey || 'selector';
    const hasRef = msg[refKey] !== undefined && msg[refKey] !== null;
    const hasSel = msg[selKey] !== undefined && msg[selKey] !== null;
    if (hasRef && hasSel) {
      fail(`provide either ${refKey} or ${selKey}, not both`, 'EARGS');
    }
    if (hasRef) return resolveRef(msg[refKey]);
    if (hasSel) {
      if (typeof msg[selKey] !== 'string' || msg[selKey].length === 0) {
        fail(`${selKey} must be a non-empty CSS selector`, 'EARGS');
      }
      let el = null;
      try { el = document.querySelector(msg[selKey]); } catch (e) {
        fail(`invalid CSS selector "${msg[selKey]}": ${e.message}`, 'EARGS');
      }
      if (!el) fail(`no element matches selector "${msg[selKey]}"`, 'ENO_SUCH_SELECTOR');
      return el;
    }
    fail(`one of ${refKey} or ${selKey} is required`, 'EARGS');
  }

  // ===========================================================================
  // visibility / geometry helpers
  // ===========================================================================

  function isVisible(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isAriaHidden(el) {
    try { return el.getAttribute('aria-hidden') === 'true'; } catch (e) { return false; }
  }

  function isFocusable(el) {
    try {
      if (el.disabled) return false;
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' ||
          (tag === 'INPUT' && el.type !== 'hidden')) return true;
      if (tag === 'A') return el.getAttribute('href') != null;
      if (el.hasAttribute('contenteditable')) return true;
      const ti = el.getAttribute('tabindex');
      return ti !== null && ti !== '-1';
    } catch (e) {
      return false;
    }
  }

  function scrollIntoViewIfNeeded(el) {
    try {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (rect.top < 0 || rect.bottom > vh || rect.left < 0 || rect.right > vw) {
        try {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch (e) {
          el.scrollIntoView();
        }
      }
    } catch (e) { /* noop */ }
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  function describeText(el) {
    let t = '';
    try { t = (el.innerText || '').trim(); } catch (e) { /* noop */ }
    if (!t) {
      try { if (el.value !== undefined && el.value !== null && el.value !== '') t = String(el.value); } catch (e) { /* noop */ }
    }
    if (!t) {
      try {
        const al = el.getAttribute('aria-label');
        if (al) t = al;
      } catch (e) { /* noop */ }
    }
    if (t.length > 120) t = t.slice(0, 120);
    return t;
  }

  // ===========================================================================
  // snapshot
  // ===========================================================================

  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, summary, [onclick], [contenteditable], [role]';

  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
    reset: 'button', number: 'spinbutton', range: 'slider', search: 'searchbox',
    email: 'textbox', text: 'textbox', password: 'textbox', tel: 'textbox',
    url: 'textbox', date: 'textbox', 'datetime-local': 'textbox', month: 'textbox',
    week: 'textbox', time: 'textbox', color: 'textbox', file: 'textbox'
  };

  function inferRole(el) {
    try {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.trim().split(/\s+/)[0];
    } catch (e) { /* noop */ }
    const tag = el.tagName;
    if (tag === 'A') return el.getAttribute('href') != null ? 'link' : undefined;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'INPUT') return INPUT_ROLES[el.type] || 'textbox';
    if (el.hasAttribute('contenteditable')) return 'textbox';
    return undefined;
  }

  function serializeElement(el, rect) {
    const out = { ref: refFor(el), tag: el.tagName.toLowerCase() };
    const role = inferRole(el);
    if (role) out.role = role;
    let text = '';
    try { text = (el.innerText || '').trim(); } catch (e) { /* noop */ }
    if (text.length > 120) text = text.slice(0, 120);
    if (text) out.text = text;
    try {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) out.ariaLabel = ariaLabel;
    } catch (e) { /* noop */ }
    const tag = out.tag;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      try {
        if (el.value !== undefined && el.value !== null && el.value !== '') {
          out.value = String(el.value);
        }
      } catch (e) { /* noop */ }
      try {
        const ph = el.getAttribute('placeholder');
        if (ph) out.placeholder = ph;
      } catch (e) { /* noop */ }
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        out.checked = !!el.checked;
      }
    }
    if (tag === 'a') {
      try {
        const hrefAttr = el.getAttribute('href');
        if (hrefAttr !== null && hrefAttr !== '') out.href = el.href || hrefAttr;
      } catch (e) { /* noop */ }
    }
    try {
      const name = el.getAttribute('name');
      if (name) out.name = name;
    } catch (e) { /* noop */ }
    if (el.id) out.id = el.id;
    out.rect = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    };
    out.visible = true; // everything collected here passed the visibility filter
    if (tag === 'select') {
      const labels = [];
      try {
        for (const opt of el.options) {
          if (labels.length >= 30) break;
          labels.push(opt.label != null && opt.label !== '' ? opt.label : (opt.text || ''));
        }
      } catch (e) { /* noop */ }
      out.options = labels;
    }
    return out;
  }

  function doSnapshot(msg) {
    if (!document.body) fail('document.body is not available yet', 'EEXECUTION');
    const maxElements = Math.max(1, Number.isFinite(+msg.maxElements) ? Math.trunc(+msg.maxElements) : 800);
    const viewportOnly = !!msg.viewportOnly;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const elements = [];
    let truncated = false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      const el = node;
      let matches = false;
      try { matches = el.matches(INTERACTIVE_SELECTOR); } catch (e) { continue; }
      if (!matches) continue;
      if (elements.length >= maxElements) { truncated = true; break; }
      if (!isVisible(el)) continue;
      if (isAriaHidden(el) && !isFocusable(el)) continue;
      const rect = el.getBoundingClientRect();
      if (viewportOnly &&
          (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw)) {
        continue;
      }
      elements.push(serializeElement(el, rect));
    }
    return {
      url: location.href,
      title: document.title || '',
      viewport: {
        scrollX: Math.round(window.scrollX || 0),
        scrollY: Math.round(window.scrollY || 0),
        width: vw,
        height: vh
      },
      elements,
      truncated
    };
  }

  // ===========================================================================
  // page text / links / wait_for / scroll
  // ===========================================================================

  function doGetPageText(msg) {
    if (!document.body) fail('document.body is not available yet', 'EEXECUTION');
    const maxChars = Math.max(0, Number.isFinite(+msg.maxChars) ? Math.trunc(+msg.maxChars) : 20000);
    let full = '';
    try { full = document.body.innerText || ''; } catch (e) { full = ''; }
    const truncated = full.length > maxChars;
    return {
      url: location.href,
      title: document.title || '',
      text: truncated ? full.slice(0, maxChars) : full,
      truncated
    };
  }

  function doGetLinks() {
    const links = [];
    let anchors;
    try { anchors = document.querySelectorAll('a[href]'); } catch (e) { anchors = []; }
    for (const a of anchors) {
      if (links.length >= 300) break;
      let href = '';
      try { href = a.href || ''; } catch (e) { /* noop */ }
      if (!href) continue;
      let text = '';
      try { text = (a.innerText || a.textContent || '').trim(); } catch (e) { /* noop */ }
      if (text.length > 120) text = text.slice(0, 120);
      let internal = false;
      try {
        internal = new URL(href, location.href).origin === location.origin;
      } catch (e) { internal = false; }
      links.push({ text, href, internal });
    }
    return { links };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function doWaitFor(msg) {
    const hasText = typeof msg.text === 'string' && msg.text.length > 0;
    const hasSel = typeof msg.selector === 'string' && msg.selector.length > 0;
    if (hasText === hasSel) fail('exactly one of text or selector is required', 'EARGS');
    const timeoutMs = Number.isFinite(+msg.timeoutMs) && +msg.timeoutMs > 0 ? +msg.timeoutMs : 10000;
    const start = Date.now();
    if (hasSel) {
      try { document.querySelector(msg.selector); } catch (e) {
        fail(`invalid CSS selector "${msg.selector}": ${e.message}`, 'EARGS');
      }
    }
    while (true) {
      if (hasText) {
        let bodyText = '';
        try { bodyText = document.body ? document.body.innerText : ''; } catch (e) { /* noop */ }
        if (bodyText.indexOf(msg.text) !== -1) {
          return { found: true, matched: 'text', url: location.href, title: document.title || '' };
        }
      } else {
        let el = null;
        try { el = document.querySelector(msg.selector); } catch (e) { el = null; }
        if (el) {
          return { found: true, matched: 'selector', url: location.href, title: document.title || '' };
        }
      }
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        return { found: false, matched: 'none', url: location.href, title: document.title || '' };
      }
      await sleep(Math.min(250, Math.max(50, timeoutMs - elapsed)));
    }
  }

  async function doScroll(msg) {
    const direction = ['up', 'down', 'left', 'right'].indexOf(msg.direction) >= 0
      ? msg.direction : 'down';
    const amount = Number.isFinite(+msg.amount) ? Math.max(0, Math.trunc(+msg.amount)) : 600;
    const smooth = msg.smooth !== false;
    const behavior = smooth ? 'smooth' : 'auto';
    let target = null;
    if (msg.ref !== undefined || msg.selector !== undefined) {
      target = resolveTarget(msg);
    }
    const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    try {
      if (target) target.scrollBy({ top: dy, left: dx, behavior });
      else window.scrollBy({ top: dy, left: dx, behavior });
    } catch (e) {
      try {
        if (target) target.scrollTop += dy, target.scrollLeft += dx;
        else window.scrollBy(dx, dy);
      } catch (e2) { /* noop */ }
    }
    // With smooth scrolling, wait for the position to settle before reporting.
    if (smooth) {
      let last = `${window.scrollX},${window.scrollY}`;
      let stable = 0;
      const deadline = Date.now() + 1200;
      while (Date.now() < deadline && stable < 3) {
        await sleep(60);
        const cur = `${window.scrollX},${window.scrollY}`;
        stable = cur === last ? stable + 1 : 0;
        last = cur;
      }
    }
    return { scrollX: Math.round(window.scrollX || 0), scrollY: Math.round(window.scrollY || 0) };
  }

  // ===========================================================================
  // synthetic event machinery
  // ===========================================================================

  const HAS_POINTER_EVENT = typeof PointerEvent === 'function';
  const HAS_INPUT_EVENT = typeof InputEvent === 'function';
  const HAS_DRAG_EVENT = typeof DragEvent === 'function';

  function parseModifierList(modifiers) {
    const set = new Set();
    for (const raw of Array.isArray(modifiers) ? modifiers : []) {
      const m = String(raw || '').toLowerCase();
      if (m === 'alt' || m === 'option') set.add('alt');
      else if (m === 'control' || m === 'ctrl') set.add('ctrl');
      else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'windows') set.add('meta');
      else if (m === 'shift') set.add('shift');
    }
    return set;
  }

  function modifierFields(modifiers) {
    const s = parseModifierList(modifiers);
    return { altKey: s.has('alt'), ctrlKey: s.has('ctrl'), metaKey: s.has('meta'), shiftKey: s.has('shift') };
  }

  function safeDispatch(el, ev) {
    try { el.dispatchEvent(ev); } catch (e) { /* page listeners may throw; swallow */ }
    return ev;
  }

  function pointerEvent(type, opts) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: opts.clientX,
      clientY: opts.clientY,
      button: opts.button || 0,
      buttons: opts.buttons || 0,
      relatedTarget: opts.relatedTarget || null,
      modifiers: opts.modifiers
    };
    const fields = modifierFields(base.modifiers);
    if (HAS_POINTER_EVENT) {
      return new PointerEvent(type, Object.assign({}, base, fields, {
        pointerId: opts.pointerId || 1,
        pointerType: 'mouse',
        isPrimary: true,
        width: 1,
        height: 1,
        pressure: type === 'pointerdown' ? 0.5 : 0
      }));
    }
    // PointerEvent unavailable — fall back to MouseEvent carrying pointer
    // fields as inert expandos (best effort for frameworks keying on them).
    const ev = new MouseEvent(type, Object.assign({}, base, fields));
    try {
      Object.defineProperty(ev, 'pointerId', { value: opts.pointerId || 1 });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      Object.defineProperty(ev, 'isPrimary', { value: true });
    } catch (e) { /* non-configurable event */ }
    return ev;
  }

  function mouseEvent(type, opts) {
    return new MouseEvent(type, Object.assign({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: opts.clientX,
      clientY: opts.clientY,
      button: opts.button || 0,
      buttons: opts.buttons || 0,
      detail: opts.detail || 1,
      relatedTarget: opts.relatedTarget || null
    }, modifierFields(opts.modifiers)));
  }

  function keyboardEvent(type, opts) {
    const fields = modifierFields(opts.modifiers);
    return new KeyboardEvent(type, Object.assign({}, fields, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      key: opts.key,
      code: opts.code,
      location: 0,
      repeat: !!opts.repeat
    }));
  }

  function makeInputEvent(type, init) {
    if (HAS_INPUT_EVENT) return new InputEvent(type, init);
    const ev = new Event(type, init);
    try {
      if (init.inputType) Object.defineProperty(ev, 'inputType', { value: init.inputType });
      if ('data' in init) Object.defineProperty(ev, 'data', { value: init.data });
    } catch (e) { /* noop */ }
    return ev;
  }

  function makeDataTransfer() {
    try { return new DataTransfer(); } catch (e) { return null; }
  }

  function dragEvent(type, opts) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: opts.clientX,
      clientY: opts.clientY,
      button: 0,
      buttons: type === 'dragover' || type === 'drop' ? 1 : 0
    };
    const fields = modifierFields(opts.modifiers);
    Object.assign(init, fields);
    if (opts.dataTransfer) init.dataTransfer = opts.dataTransfer;
    if (HAS_DRAG_EVENT) {
      try { return new DragEvent(type, init); } catch (e) { /* fall through */ }
    }
    const ev = new CustomEvent(type, init);
    try {
      Object.defineProperty(ev, 'dataTransfer', { value: opts.dataTransfer || null });
    } catch (e) { /* noop */ }
    return ev;
  }

  // ---- key parsing (mirrors the service worker's util.parseKeyCombo) --------

  const NAMED_KEYS = {
    enter: { key: 'Enter', code: 'Enter', vk: 13 },
    return: { key: 'Enter', code: 'Enter', vk: 13 },
    tab: { key: 'Tab', code: 'Tab', vk: 9 },
    escape: { key: 'Escape', code: 'Escape', vk: 27 },
    esc: { key: 'Escape', code: 'Escape', vk: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    delete: { key: 'Delete', code: 'Delete', vk: 46 },
    del: { key: 'Delete', code: 'Delete', vk: 46 },
    insert: { key: 'Insert', code: 'Insert', vk: 45 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    home: { key: 'Home', code: 'Home', vk: 36 },
    end: { key: 'End', code: 'End', vk: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
    space: { key: ' ', code: 'Space', vk: 32 },
    control: { key: 'Control', code: 'ControlLeft', vk: 17 },
    ctrl: { key: 'Control', code: 'ControlLeft', vk: 17 },
    alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
    meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
    shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 }
  };

  const PUNCT_CODES = {
    '`': { code: 'Backquote', vk: 192 }, '-': { code: 'Minus', vk: 189 },
    '=': { code: 'Equal', vk: 187 }, ',': { code: 'Comma', vk: 188 },
    '.': { code: 'Period', vk: 190 }, '/': { code: 'Slash', vk: 191 },
    '\\': { code: 'Backslash', vk: 220 }, ';': { code: 'Semicolon', vk: 186 },
    "'": { code: 'Quote', vk: 222 }, '[': { code: 'BracketLeft', vk: 219 },
    ']': { code: 'BracketRight', vk: 221 }
  };

  function parseKeySpec(spec) {
    if (typeof spec !== 'string' || spec.length === 0) {
      fail('key must be a non-empty string', 'EARGS');
    }
    if (spec === ' ') spec = 'Space';
    const parts = spec.split('+').map((p) => p.trim()).filter((p) => p.length > 0);
    const modifiers = [];
    let keyPart = null;
    for (const part of parts) {
      const lower = part.toLowerCase();
      const mod = lower === 'control' || lower === 'ctrl' ? 'Control'
        : lower === 'shift' ? 'Shift'
        : lower === 'alt' || lower === 'option' ? 'Alt'
        : lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'windows' ? 'Meta'
        : null;
      if (mod) { modifiers.push(mod); continue; }
      keyPart = part;
    }
    if (keyPart === null) {
      if (modifiers.length === 1) { keyPart = modifiers[0]; modifiers.length = 0; }
      else fail(`cannot parse key "${spec}"`, 'EARGS');
    }
    const lower = keyPart.toLowerCase();
    let out;
    if (NAMED_KEYS[lower]) {
      out = NAMED_KEYS[lower];
    } else if (/^f([1-9]|1[0-2])$/i.test(lower)) {
      const n = parseInt(lower.slice(1), 10);
      out = { key: 'F' + n, code: 'F' + n, vk: 111 + n };
    } else if (/^[0-9]$/.test(keyPart)) {
      out = { key: keyPart, code: 'Digit' + keyPart, vk: 48 + Number(keyPart) };
    } else if (/^[a-z]$/i.test(keyPart)) {
      const upper = keyPart.toUpperCase();
      const withShift = modifiers.indexOf('Shift') >= 0;
      out = { key: withShift ? upper : keyPart.toLowerCase(), code: 'Key' + upper, vk: upper.charCodeAt(0) };
    } else if (keyPart.length === 1 && PUNCT_CODES[keyPart]) {
      out = { key: keyPart, code: PUNCT_CODES[keyPart].code, vk: PUNCT_CODES[keyPart].vk };
    } else {
      fail(`unknown key "${keyPart}" in "${spec}"`, 'EARGS');
    }
    const hasPlain = modifiers.indexOf('Control') < 0 && modifiers.indexOf('Meta') < 0 &&
      modifiers.indexOf('Alt') < 0;
    const text = hasPlain && out.key.length === 1 ? out.key : '';
    return { key: out.key, code: out.code, vk: out.vk, text, modifiers };
  }

  // ---- editability ----------------------------------------------------------

  const NON_TEXT_INPUT_TYPES = new Set([
    'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'image', 'range', 'color'
  ]);

  function isContentEditable(el) {
    try {
      if (el.hasAttribute && el.hasAttribute('contenteditable')) {
        const v = el.getAttribute('contenteditable');
        return v === '' || v === 'true';
      }
    } catch (e) { /* noop */ }
    return false;
  }

  function isEditable(el) {
    if (!el) return false;
    if (isContentEditable(el)) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !NON_TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase());
    return false;
  }

  function nativeValueSetter(el) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!desc || typeof desc.set !== 'function') return null;
    return desc.set;
  }

  function setValueNatively(el, value) {
    const setter = nativeValueSetter(el);
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function insertTextAtCaret(el, text) {
    try {
      const sel = window.getSelection();
      if (!sel.rangeCount || (sel.anchorNode && !el.contains(sel.anchorNode))) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      try { el.textContent = (el.textContent || '') + text; } catch (e2) { /* noop */ }
    }
  }

  function charToKeyCode(ch) {
    const upper = ch.toUpperCase();
    if (/^[A-Z]$/.test(upper)) return { code: 'Key' + upper, vk: upper.charCodeAt(0) };
    if (/^[0-9]$/.test(ch)) return { code: 'Digit' + ch, vk: 48 + Number(ch) };
    if (ch === ' ') return { code: 'Space', vk: 32 };
    if (PUNCT_CODES[ch]) return { code: PUNCT_CODES[ch].code, vk: PUNCT_CODES[ch].vk };
    return { code: '', vk: 0 };
  }

  // ===========================================================================
  // interactions
  // ===========================================================================

  function applyClickDefault(el) {
    try {
      const tag = el.tagName;
      if (tag === 'A') {
        const hrefAttr = el.getAttribute('href');
        if (hrefAttr === null || hrefAttr === '') return;
        const url = new URL(hrefAttr, location.href);
        const target = el.getAttribute('target');
        if (target === '_blank') {
          window.open(url.href, '_blank', 'noopener');
          return;
        }
        location.href = url.href;
        return;
      }
      if (tag === 'SUMMARY') {
        const details = el.closest ? el.closest('details') : null;
        if (details) details.open = !details.open;
        return;
      }
      const form = el.closest ? el.closest('form') : null;
      if (form && (tag === 'BUTTON' ||
          (tag === 'INPUT' && (el.type === 'submit' || el.type === 'image')))) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit(el);
        else form.submit();
        return;
      }
      if (tag === 'LABEL') {
        const forId = el.getAttribute('for');
        let control = null;
        if (forId) control = document.getElementById(forId);
        else if (el.querySelector) {
          control = el.querySelector('input, button, select, textarea');
        }
        if (control && typeof control.click === 'function') {
          control.focus && control.focus();
          control.click(); // HTMLElement.click runs real activation behavior
        }
      }
    } catch (e) { /* default actions are best-effort */ }
  }

  function doClick(msg) {
    const el = resolveTarget(msg);
    scrollIntoViewIfNeeded(el);
    const c = center(el);
    const buttonIdx = msg.button === 'right' ? 2 : msg.button === 'middle' ? 1 : 0;
    const clickCount = Number.isInteger(+msg.clickCount) && +msg.clickCount >= 1
      ? Math.trunc(+msg.clickCount) : 1;
    const buttons = buttonIdx === 0 ? 1 : buttonIdx === 1 ? 4 : 2;
    const common = {
      clientX: c.x, clientY: c.y, button: buttonIdx, buttons,
      modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : []
    };

    const tag = el.tagName;
    // NOTE: no manual checkbox/radio toggling here. Dispatching a click event
    // runs the control's activation behavior (toggling happens exactly once,
    // preventDefault is honored), which also matches what frameworks expect.

    safeDispatch(el, pointerEvent('pointerover', Object.assign({}, common, { buttons: 0 })));
    safeDispatch(el, mouseEvent('mouseover', Object.assign({}, common, { buttons: 0 })));
    safeDispatch(el, pointerEvent('pointermove', Object.assign({}, common, { buttons: 0 })));
    safeDispatch(el, pointerEvent('pointerdown', common));
    safeDispatch(el, mouseEvent('mousedown', common));
    if (isFocusable(el)) {
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* noop */ } }
    }
    safeDispatch(el, pointerEvent('pointerup', common));
    safeDispatch(el, mouseEvent('mouseup', common));

    let defaultPrevented = false;
    if (buttonIdx === 0) {
      const clickEv = safeDispatch(el, mouseEvent('click', Object.assign({}, common, {
        detail: clickCount
      })));
      defaultPrevented = clickEv.defaultPrevented;
      if (clickCount === 2) {
        safeDispatch(el, mouseEvent('dblclick', Object.assign({}, common, { detail: 2 })));
      }
    }
    if (!defaultPrevented && buttonIdx === 0) applyClickDefault(el);

    const text = describeText(el);
    return { clicked: true, tag: tag.toLowerCase(), text: text || undefined };
  }

  function doHover(msg) {
    const el = resolveTarget(msg);
    scrollIntoViewIfNeeded(el);
    const c = center(el);
    const common = { clientX: c.x, clientY: c.y, button: 0, buttons: 0, modifiers: [] };
    safeDispatch(el, pointerEvent('pointerover', common));
    safeDispatch(el, mouseEvent('mouseover', common));
    safeDispatch(el, pointerEvent('pointermove', common));
    // cleanup so :hover state and listeners can settle
    safeDispatch(el, pointerEvent('pointerout', common));
    safeDispatch(el, mouseEvent('mouseout', common));
    return { hovered: true };
  }

  function clearEditable(el) {
    if (isContentEditable(el)) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand('delete'); } catch (e) {
          el.textContent = '';
        }
      } catch (e) {
        try { el.textContent = ''; } catch (e2) { /* noop */ }
      }
      safeDispatch(el, makeInputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null
      }));
    } else {
      setValueNatively(el, '');
      safeDispatch(el, makeInputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null
      }));
    }
  }

  async function typeCharacter(el, ch) {
    const mapped = charToKeyCode(ch);
    const keyArgs = { key: ch, code: mapped.code, modifiers: [] };
    safeDispatch(el, keyboardEvent('keydown', keyArgs));
    safeDispatch(el, keyboardEvent('keypress', keyArgs));
    safeDispatch(el, makeInputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: ch
    }));
    if (isContentEditable(el)) {
      insertTextAtCaret(el, ch);
      safeDispatch(el, makeInputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ch
      }));
    } else {
      setValueNatively(el, (el.value || '') + ch);
      safeDispatch(el, makeInputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ch
      }));
    }
    safeDispatch(el, keyboardEvent('keyup', keyArgs));
  }

  function submitViaEnter(el) {
    const form = el.closest ? el.closest('form') : null;
    let submitted = false;
    let onSubmit = null;
    if (form) {
      onSubmit = () => { submitted = true; };
      try { form.addEventListener('submit', onSubmit, { once: true, capture: true }); } catch (e) { /* noop */ }
    }
    const keydown = safeDispatch(el, keyboardEvent('keydown', { key: 'Enter', code: 'Enter', modifiers: [] }));
    safeDispatch(el, keyboardEvent('keyup', { key: 'Enter', code: 'Enter', modifiers: [] }));
    if (form && onSubmit) {
      try { form.removeEventListener('submit', onSubmit, { capture: true }); } catch (e) { /* noop */ }
    }
    if (form && !submitted && !keydown.defaultPrevented) {
      try {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } catch (e) { /* noop */ }
    }
  }

  async function doTypeText(msg) {
    if (typeof msg.text !== 'string') fail('text is required and must be a string', 'EARGS');
    const clearFirst = msg.clearFirst !== false;
    const submit = !!msg.submit;
    const el = resolveTarget(msg);
    scrollIntoViewIfNeeded(el);
    if (!isEditable(el)) {
      fail(`element <${el.tagName.toLowerCase()}> is not a text input target`, 'EEXECUTION');
    }
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { /* noop */ } }
    if (clearFirst) clearEditable(el);
    for (const ch of msg.text) await typeCharacter(el, ch);
    safeDispatch(el, new Event('change', { bubbles: true }));
    if (submit) submitViaEnter(el);
    return { typed: true };
  }

  function focusableElements() {
    const selector = 'a[href], button, input, select, textarea, ' +
      '[tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';
    let list = [];
    try { list = Array.from(document.querySelectorAll(selector)); } catch (e) { return []; }
    return list.filter((el) => {
      try {
        return !el.disabled && isVisible(el) &&
          !isAriaHidden(el) && el.getClientRects().length > 0;
      } catch (e) {
        return false;
      }
    });
  }

  function moveFocus(fromEl, forward) {
    try {
      const list = focusableElements();
      if (!list.length) return;
      const idx = list.indexOf(fromEl);
      let next;
      if (idx === -1) next = list[0];
      else next = list[(idx + (forward ? 1 : -1) + list.length) % list.length];
      if (next) {
        try { next.focus({ preventScroll: false }); } catch (e) { next.focus(); }
      }
    } catch (e) { /* noop */ }
  }

  function doPressKey(msg) {
    const combo = parseKeySpec(msg.key);
    let el = null;
    if (msg.ref !== undefined || msg.selector !== undefined) {
      el = resolveTarget(msg);
      scrollIntoViewIfNeeded(el);
    } else {
      el = document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document.body;
    }
    const target = el || document.body;
    const keyArgs = { key: combo.key, code: combo.code, modifiers: combo.modifiers };

    const keydown = safeDispatch(target, keyboardEvent('keydown', keyArgs));

    // Printable, unmodified keys insert text into editable targets.
    const hasPlain = combo.modifiers.indexOf('Control') < 0 &&
      combo.modifiers.indexOf('Meta') < 0 && combo.modifiers.indexOf('Alt') < 0;
    if (hasPlain && combo.text && isEditable(target)) {
      safeDispatch(target, makeInputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: combo.text
      }));
      if (isContentEditable(target)) insertTextAtCaret(target, combo.text);
      else setValueNatively(target, (target.value || '') + combo.text);
      safeDispatch(target, makeInputEvent('input', {
        bubbles: true, inputType: 'insertText', data: combo.text
      }));
    }

    safeDispatch(target, keyboardEvent('keyup', keyArgs));

    if (!keydown.defaultPrevented) {
      try {
        if (combo.key === 'Enter') {
          if (target.tagName === 'BUTTON' || (target.tagName === 'INPUT' &&
              ['submit', 'button'].includes(target.type))) {
            applyClickDefault(target);
          } else if (target.closest && target.closest('form')) {
            submitViaEnter(target);
          }
        } else if (combo.key === 'Tab') {
          moveFocus(target, combo.modifiers.indexOf('Shift') < 0);
        } else if (combo.key === ' ' && target.tagName === 'BUTTON') {
          const clickEv = safeDispatch(target, mouseEvent('click', {
            clientX: 0, clientY: 0, button: 0, buttons: 1, detail: 1, modifiers: []
          }));
          if (!clickEv.defaultPrevented) applyClickDefault(target);
        }
      } catch (e) { /* default actions are best-effort */ }
    }
    return { pressed: true };
  }

  function doSelectOption(msg) {
    const el = resolveTarget(msg);
    if (el.tagName !== 'SELECT') {
      fail(`element <${el.tagName.toLowerCase()}> is not a <select>`, 'EEXECUTION');
    }
    const provided = ['value', 'label', 'index'].filter(
      (k) => msg[k] !== undefined && msg[k] !== null
    );
    if (provided.length !== 1) {
      fail('exactly one of value / label / index is required', 'EARGS');
    }
    let options = [];
    try { options = Array.from(el.options || []); } catch (e) { options = []; }
    const which = provided[0];
    let matches = [];
    if (which === 'value') {
      const want = String(msg.value);
      matches = options.filter((o) => String(o.value) === want);
    } else if (which === 'label') {
      const want = String(msg.label).trim();
      matches = options.filter((o) => {
        const label = ((o.label != null && o.label !== '') ? o.label : o.text) || '';
        return label.trim() === want;
      });
    } else {
      const idx = msg.index;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
        fail('index must be a non-negative integer', 'EARGS');
      }
      matches = idx < options.length ? [options[idx]] : [];
    }
    if (!matches.length) {
      const shown = which === 'index' ? msg.index : JSON.stringify(msg[which]);
      fail(`no <option> matches ${which}=${shown}`, 'ENO_SUCH_SELECTOR');
    }
    try {
      if (el.multiple) {
        for (const o of options) o.selected = matches.indexOf(o) !== -1;
      } else {
        el.value = matches[0].value;
      }
    } catch (e) { /* noop */ }
    safeDispatch(el, new Event('input', { bubbles: true }));
    safeDispatch(el, new Event('change', { bubbles: true }));
    const selected = matches.map((o) => String(o.value));
    return { selected };
  }

  async function doDrag(msg) {
    const from = resolveTarget(msg, 'fromRef', 'fromSelector');
    const to = resolveTarget(msg, 'toRef', 'toSelector');
    scrollIntoViewIfNeeded(from);
    scrollIntoViewIfNeeded(to);
    const a = center(from);
    const b = center(to);
    const steps = 8;
    const dt = makeDataTransfer();

    safeDispatch(from, pointerEvent('pointerdown', {
      clientX: a.x, clientY: a.y, button: 0, buttons: 1, modifiers: []
    }));
    safeDispatch(from, mouseEvent('mousedown', {
      clientX: a.x, clientY: a.y, button: 0, buttons: 1, modifiers: []
    }));
    const dragStartEv = safeDispatch(from, dragEvent('dragstart', {
      clientX: a.x, clientY: a.y, dataTransfer: dt
    }));
    const html5DnD = !dragStartEv.defaultPrevented;

    for (let i = 1; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      let over = null;
      try { over = document.elementFromPoint(x, y); } catch (e) { /* noop */ }
      const stepTarget = i === steps ? to : (over || from);
      safeDispatch(stepTarget, pointerEvent('pointermove', {
        clientX: x, clientY: y, button: 0, buttons: 1, modifiers: []
      }));
      safeDispatch(stepTarget, mouseEvent('mousemove', {
        clientX: x, clientY: y, button: 0, buttons: 1, modifiers: []
      }));
      if (html5DnD) {
        safeDispatch(stepTarget, dragEvent('dragover', { clientX: x, clientY: y, dataTransfer: dt }));
      }
      await sleep(16);
    }
    if (html5DnD) {
      safeDispatch(to, dragEvent('drop', { clientX: b.x, clientY: b.y, dataTransfer: dt }));
    }
    safeDispatch(to, pointerEvent('pointerup', {
      clientX: b.x, clientY: b.y, button: 0, buttons: 0, modifiers: []
    }));
    safeDispatch(to, mouseEvent('mouseup', {
      clientX: b.x, clientY: b.y, button: 0, buttons: 0, modifiers: []
    }));
    if (html5DnD) {
      safeDispatch(from, dragEvent('dragend', { clientX: b.x, clientY: b.y, dataTransfer: dt }));
    }
    return { dragged: true };
  }

  function doLocate(msg) {
    const el = resolveTarget(msg);
    if (msg.scroll !== false) scrollIntoViewIfNeeded(el);
    const c = center(el);
    const text = describeText(el);
    return {
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
      w: Math.round(c.w),
      h: Math.round(c.h),
      tag: el.tagName.toLowerCase(),
      text: text || undefined
    };
  }

  // ===========================================================================
  // message handling
  // ===========================================================================

  const OPS = {
    ping: () => ({ ok: true }),
    snapshot: (msg) => Object.assign({ ok: true }, doSnapshot(msg)),
    get_page_text: (msg) => Object.assign({ ok: true }, doGetPageText(msg)),
    get_links: () => Object.assign({ ok: true }, doGetLinks()),
    wait_for: (msg) => doWaitFor(msg),
    scroll: (msg) => doScroll(msg),
    click: (msg) => Object.assign({ ok: true }, doClick(msg)),
    hover: (msg) => Object.assign({ ok: true }, doHover(msg)),
    type_text: (msg) => doTypeText(msg),
    press_key: (msg) => Object.assign({ ok: true }, doPressKey(msg)),
    select_option: (msg) => Object.assign({ ok: true }, doSelectOption(msg)),
    drag: (msg) => doDrag(msg),
    locate: (msg) => Object.assign({ ok: true }, doLocate(msg))
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      let response;
      try {
        const op = msg && typeof msg === 'object' && typeof msg.type === 'string'
          ? OPS[msg.type] : null;
        if (!op) {
          response = { ok: false, message: `unknown op "${msg && msg.type}"`, code: 'EARGS' };
        } else {
          const res = await op(msg);
          response = res && res.ok !== undefined ? res : Object.assign({ ok: true }, res);
        }
      } catch (e) {
        response = e && e.webmcpError
          ? { ok: false, message: e.message || String(e), code: e.code || 'EEXECUTION' }
          : { ok: false, message: (e && e.message) || String(e), code: 'EEXECUTION' };
      }
      try { sendResponse(response); } catch (e) { /* channel closed */ }
    })();
    return true; // async sendResponse
  });
})();
