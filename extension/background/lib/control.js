/**
 * WebMCP Tools — manual "agent control" kill switch (classic script).
 *
 * The user can turn agent control ON/OFF from the toolbar popup. OFF halts
 * the native messaging port (WMCP.nativePort.halt), which also stops every
 * reconnection attempt, so each agent tool call fails with
 * extension_not_connected while normal browsing keeps working. ON reconnects
 * with the usual backoff.
 *
 * State is the boolean `agentControlEnabled` in chrome.storage.local; a
 * missing key means ENABLED. Everything reacts through a single
 * chrome.storage.onChanged listener (which also wakes a suspended MV3
 * service worker), so no direct wiring between popup and worker is needed.
 */
(function (global) {
  'use strict';

  const NS = (global.WMCP = global.WMCP || {});
  const STORAGE_KEY = 'agentControlEnabled';

  /** Read the switch; a missing/undefined value defaults to enabled. */
  async function isEnabled() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const v = got ? got[STORAGE_KEY] : undefined;
      return v === undefined ? true : !!v;
    } catch (e) {
      return true; // storage broken — default to enabled, never brick the agent
    }
  }

  /**
   * Persist the switch. The storage.onChanged listener below applies the
   * side effects (badge + connect/halt) in every context that cares.
   */
  async function setEnabled(enabled) {
    await chrome.storage.local.set({ [STORAGE_KEY]: !!enabled });
  }

  /** Badge + native-port side effects for a state. Safe to call repeatedly. */
  function applyState(enabled) {
    const on = !!enabled;
    try {
      chrome.action.setBadgeText({ text: on ? 'ON' : 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: on ? '#2e7d32' : '#757575' });
    } catch (e) {
      /* the badge is cosmetic — never let it break connect/halt */
    }
    if (NS.nativePort && typeof NS.nativePort.connect === 'function') {
      if (on) {
        NS.nativePort.connect(); // manual connect also clears any halt
      } else if (typeof NS.nativePort.halt === 'function') {
        NS.nativePort.halt();
      }
    }
  }

  /** Read the persisted state and apply it (badge + connect/halt). */
  async function init() {
    applyState(await isEnabled());
  }

  // Toggles from the popup (or anywhere else) land here. storage.onChanged
  // wakes a suspended MV3 service worker, so the state applies even when the
  // worker was asleep when the user flipped the switch.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes && changes[STORAGE_KEY]) {
        applyState(changes[STORAGE_KEY].newValue);
      }
    });
  } catch (e) {
    /* storage.onChanged unavailable — init/onStartup still apply the state */
  }

  // Popup status probe: answers {type:'statusRequest'} with
  // {ok:true, connected, version}. console-buffer.js registers its own
  // onMessage listener for content-script chatter; this one returns true
  // (keeps sendResponse alive) ONLY for statusRequest and stays silent for
  // every other message type.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object' || msg.type !== 'statusRequest') return;
      try {
        sendResponse({
          ok: true,
          connected: !!(NS.nativePort && typeof NS.nativePort.isConnected === 'function' && NS.nativePort.isConnected()),
          version: chrome.runtime.getManifest().version
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return true; // answered above (synchronously); no other listener needed
    });
  } catch (e) {
    /* onMessage unavailable — the popup falls back to its asleep note */
  }

  NS.control = { isEnabled, setEnabled, applyState, init };
})(self);
