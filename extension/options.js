const url = document.getElementById("url");
const msg = document.getElementById("msg");

chrome.storage.local.get("kcAppUrl", (o) => { url.value = o.kcAppUrl || ""; });

document.getElementById("save").addEventListener("click", () => {
  const v = url.value.trim().replace(/\/+$/, "");
  chrome.storage.local.set({ kcAppUrl: v }, () => {
    msg.textContent = "Saved — reload your tabs.";
    setTimeout(() => (msg.textContent = ""), 3000);
  });
});
