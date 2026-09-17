/**
 * WebMCP Tools — MV3 service worker (classic script).
 *
 * Loads the background libs synchronously (importScripts), wires the native
 * request router, and connects the native messaging port at top level so the
 * extension re-attaches to the relay/hub whenever Chrome wakes this worker.
 * A connected native messaging port keeps the worker alive (Chrome >= 116,
 * which matches our minimum_chrome_version).
 *
 * The agent-control kill switch (lib/control.js) gates the connection: when
 * `agentControlEnabled` is false in chrome.storage.local, the port stays
 * halted (no connect, no reconnect) and every agent tool call fails with
 * extension_not_connected.
 */
importScripts(
  'lib/util.js',
  'lib/control.js',
  'lib/native-port.js',
  'lib/tabs.js',
  'lib/content-bridge.js',
  'lib/console-buffer.js',
  'lib/cdp.js',
  'lib/screenshot.js',
  'lib/webmcp.js',
  'lib/automation.js',
  'lib/dialogs.js',
  'lib/downloads.js',
  'lib/policy.js',
  'lib/router.js'
);

chrome.runtime.onInstalled.addListener(() => {
  // Re-apply the persisted switch: badge + connect (or halt) as configured.
  WMCP.control.init();
});

chrome.runtime.onStartup.addListener(() => {
  // Badge text does not survive a browser restart — refresh it (and connect
  // when agent control is enabled).
  WMCP.control.init();
});

WMCP.nativePort.onRequest((tool, params) => WMCP.router.dispatch(tool, params));

// Apply the persisted agent-control state on every service-worker start:
// sets the toolbar badge and connects the native port only when enabled.
// (WMCP.control.init() -> applyState(enabled) -> connect() when enabled.)
WMCP.control.init();

// MV3 can SUSPEND the service worker mid-backoff, which would stall the
// reconnect forever (e.g. after the MCP server restarts with a new hub). A
// periodic alarm wakes the worker to retry the native connection even when
// no other event does. periodInMinutes 0.5 = worst-case ~30 s reconnect.
// The retry is gated on the kill switch: no attempts while disabled.
try {
  chrome.alarms.create('webmcp-reconnect', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'webmcp-reconnect') return;
    WMCP.control.isEnabled().then((ok) => {
      if (ok && !WMCP.nativePort.isConnected()) {
        WMCP.nativePort.connect();
      }
    });
  });
} catch (e) {
  /* alarms unavailable in this Chrome — top-level connect still applies */
}
