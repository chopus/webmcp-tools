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

// MV3 can SUSPEND the service worker mid-backoff, which would stall the
// reconnect forever (e.g. after the MCP server restarts with a new hub). A
// periodic alarm wakes the worker to retry the native connection even when
// no other event does. periodInMinutes 0.5 = worst-case ~30 s reconnect.
try {
  chrome.alarms.create('webmcp-reconnect', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'webmcp-reconnect' && !WMCP.nativePort.isConnected()) {
      WMCP.nativePort.connect();
    }
  });
} catch (e) {
  /* alarms unavailable in this Chrome — top-level connect still applies */
}
