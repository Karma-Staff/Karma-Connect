/* Karma Connect Dialer — background service worker (MV3).
 *
 * Two jobs today:
 *   1. "Call with Karma Connect" on a selected number or a tel: link, which
 *      hands the number to the floating widget on that tab.
 *   2. The toolbar icon toggles the widget on the current tab.
 *
 * Phase 2 (keeping a call alive across full page loads) will live here too: an
 * MV3 *offscreen document* that holds the RingCentral WebPhone so the audio is
 * owned by the extension, not by any one tab. The visible widget then becomes
 * pure UI that talks to the offscreen document through this worker. See
 * README.md — it is stubbed, not wired, on purpose. */

const MENU_ID = "kc-call-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Call "%s" with Karma Connect',
    contexts: ["selection", "link"],
  });
});

// Pull the first phone-looking run of digits out of some text.
function pickNumber(text) {
  const m = String(text || "").match(/\+?[\d][\d\s().\-]{6,}\d/);
  if (!m) return "";
  const raw = m[0].replace(/[^\d+]/g, "");
  return raw.length >= 7 ? raw : "";
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  let number = "";
  if (info.linkUrl && info.linkUrl.startsWith("tel:")) number = decodeURIComponent(info.linkUrl.slice(4));
  if (!number) number = pickNumber(info.selectionText);
  if (number) chrome.tabs.sendMessage(tab.id, { type: "kc-call", number });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "kc-toggle" });
});
