/**
 * WebMCP Tools — agent-control kill-switch popup (classic script).
 *
 * Reads/writes `agentControlEnabled` in chrome.storage.local and lets the
 * service worker react: its chrome.storage.onChanged listener (registered by
 * background/lib/control.js) updates the badge and connects/halts the native
 * port — and it wakes the worker if it was suspended, so the toggle applies
 * even then. This script only renders state; it never talks to the port.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'agentControlEnabled';

  const toggle = document.getElementById('agentControlToggle');
  const stateText = document.getElementById('toggleState');
  const serverStatus = document.getElementById('serverStatus');
  const swNote = document.getElementById('swNote');
  const versionEl = document.getElementById('version');

  /** undefined (missing key) means enabled, mirroring WMCP.control. */
  function normalize(value) {
    return value === undefined ? true : !!value;
  }

  function render(enabled) {
    const on = !!enabled;
    toggle.checked = on;
    stateText.textContent = on ? 'ON' : 'OFF';
    stateText.className = 'stateText ' + (on ? 'on' : 'off');
  }

  function renderStatus(connected) {
    serverStatus.textContent = 'Server: ' + (connected ? 'connected' : 'not connected');
  }

  /** Ask the service worker for the native-port status; tolerate a dead SW. */
  function askStatus() {
    try {
      chrome.runtime.sendMessage({ type: 'statusRequest' }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.ok !== true) {
          swNote.hidden = false;
          renderStatus(false);
          return;
        }
        swNote.hidden = true;
        renderStatus(!!resp.connected);
      });
    } catch (e) {
      swNote.hidden = false;
      renderStatus(false);
    }
  }

  async function loadState() {
    let enabled = true;
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      enabled = normalize(got ? got[STORAGE_KEY] : undefined);
    } catch (e) {
      /* storage read failed — default to enabled */
    }
    render(enabled);
  }

  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    render(enabled); // optimistic; the storage listener below corrects drift
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: enabled }, () => {
        void chrome.runtime.lastError; // write failures surface via the note
      });
      askStatus(); // connected line reflects the (upcoming) port state
    } catch (e) {
      swNote.hidden = false;
    }
  });

  // Stay in sync when the switch is flipped elsewhere (another popup, a
  // future options page, devtools) — same default-true normalization.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes && changes[STORAGE_KEY]) {
      render(normalize(changes[STORAGE_KEY].newValue));
    }
  });

  try {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (e) {
    versionEl.textContent = '';
  }

  loadState();
  askStatus();
})(self);
