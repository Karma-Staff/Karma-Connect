/* The extension-hosted shim between the floating panel and the real dialer.
 *
 * The content script frames THIS page (exempt from the host site's CSP), and
 * this page frames the actual Karma Connect dialer (whose URL + token arrive in
 * the location hash). It then relays dial messages between the two: the content
 * script posts "dial" to this page, and this page forwards it on to the dialer. */
(function () {
  "use strict";
  const url = decodeURIComponent((location.hash || "").slice(1));
  const dialer = document.getElementById("dialer");
  if (url) dialer.src = url;

  // content script (our parent) → the dialer frame
  window.addEventListener("message", (e) => {
    if (e.source === window.parent && e.data && e.data.kc === "dial") {
      dialer.contentWindow && dialer.contentWindow.postMessage(e.data, "*");
    }
  });
})();
