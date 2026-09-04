/**
 * WebMCP Tools — MAIN-world console hook (also injected as a file via
 * chrome.scripting world:"MAIN" by the service worker).
 *
 * Wraps the PAGE's console methods + error events and forwards them to the
 * content script (isolated world) via window.postMessage; the content script
 * relays them to the service worker's ring buffer. The content script itself
 * can only wrap its own isolated-world console, which page scripts never use.
 *
 * Idempotent via window.__webmcpConsoleHooked.
 */
(function () {
  'use strict';
  if (window.__webmcpConsoleHooked) return;
  try { window.__webmcpConsoleHooked = true; } catch (e) { return; }

  function fmtArgs(args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var v = args[i];
        if (typeof v === 'string') { parts.push(v); continue; }
        if (v instanceof Error) { parts.push(v.stack || (v.name + ': ' + v.message)); continue; }
        var s;
        try { s = JSON.stringify(v); } catch (e) { s = String(v); }
        parts.push(s === undefined ? String(v) : s);
      }
      var text = parts.join(' ');
      return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
    } catch (e) {
      return '[unserializable]';
    }
  }

  function send(level, text) {
    try { window.postMessage({ __webmcpConsole: 1, level: level, text: text }, '*'); } catch (e) { /* never break the page */ }
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    try {
      var original = console[level];
      if (typeof original !== 'function') return;
      console[level] = function () {
        send(level, fmtArgs(arguments));
        try { return original.apply(console, arguments); } catch (e) { /* noop */ }
      };
    } catch (e) { /* read-only console */ }
  });

  window.addEventListener('error', function (e) {
    try {
      var text = e.message || 'Script error';
      if (e.filename) text += ' (' + e.filename + ':' + (e.lineno || 0) + ')';
      send('error', text);
    } catch (err) { /* noop */ }
  });

  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e.reason;
      var text = (r && (r.stack || r.message)) || String(r);
      send('error', 'Unhandled rejection: ' + text);
    } catch (err) { /* noop */ }
  });
})();
