/* Where the Karma Connect app lives. This is the one thing you MUST set.
 *
 *   - The deployed app:   https://your-app.onrender.com
 *   - Local dev:          http://localhost:8080
 *
 * No trailing slash. The dialler is loaded from <KC_APP_URL>/?embed=dialer.
 * You can also set it per-machine from the extension's Options page (that
 * wins over this value), which is handy when reps are on different URLs. */
globalThis.KC_APP_URL_DEFAULT = "https://your-app.onrender.com";
