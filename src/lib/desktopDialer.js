// Opens the Karma Connect Dialer desktop app (desktop/) alongside the web app.
// The desktop app registers the karmaconnect:// link with Windows; following it
// starts the app, or brings it back from its bubble if it is already running.
// If the app is not installed, the browser has nothing to hand the link to and
// quietly does nothing.
//
// Once per browser session, Windows only, and never inside the desktop app's
// own window (it loads Karma Connect pages too) — so a reload does not re-ask.

const SESSION_KEY = "kc_desktop_dialer_opened";

export function openDesktopDialer() {
  try {
    if (!/Windows/i.test(navigator.userAgent) || /Electron/i.test(navigator.userAgent)) return;
    if (sessionStorage.getItem(SESSION_KEY)) return;
    sessionStorage.setItem(SESSION_KEY, "1");
    window.location.href = "karmaconnect://open";
  } catch (e) { /* storage blocked, or no handler — not worth bothering anyone */ }
}
