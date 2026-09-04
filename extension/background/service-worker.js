/**
 * WebMCP Tools — MV3 service worker (classic script).
 *
 * Loads the background libs synchronously (importScripts), wires the native
 * request router, and connects the native messaging port at top level so the
 * extension re-attaches to the relay/hub whenever Chrome wakes this worker.
 * A connected native messaging port keeps the worker alive (Chrome >= 116,
 * which matches our minimum_chrome_version).
 */
importScripts(
  'lib/util.js',
  'lib/native-port.js',
  'lib/tabs.js',
  'lib/content-bridge.js',
  'lib/console-buffer.js',
  'lib/cdp.js',
  'lib/screenshot.js',
  'lib/webmcp.js',
  'lib/automation.js',
  'lib/router.js'
);

chrome.runtime.onInstalled.addListener(() => {
  WMCP.nativePort.connect();
});

chrome.runtime.onStartup.addListener(() => {
  WMCP.nativePort.connect();
});

WMCP.nativePort.onRequest((tool, params) => WMCP.router.dispatch(tool, params));

// Connect immediately on every service-worker start. The port stays open for
// the worker's lifetime and reconnects (with backoff) if the relay dies.
WMCP.nativePort.connect();
