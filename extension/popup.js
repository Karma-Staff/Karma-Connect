// Popup renderer. It holds no network logic — it messages the background worker and
// reflects chrome.storage. Search results are read from storage so a search that finished
// while the popup was closed still shows up on reopen.

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

const savedIds = new Set(); // cards saved this session (id = index-based key)

function showBanner(text, kind) {
  const b = $("banner");
  b.textContent = text;
  b.className = "banner" + (kind === "info" ? " info" : "");
  b.classList.toggle("hidden", !text);
}

function esc(s) { return String(s == null ? "" : s); }
function safeUrl(u) {
  const s = esc(u).trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

function leadKey(lead, i) { return (lead.company || lead.contactName || "") + "|" + i; }

function renderResults(state) {
  const wrap = $("results");
  wrap.innerHTML = "";

  if (!state || (!state.results?.length && state.status !== "loading" && state.status !== "error")) return;

  if (state.status === "loading") {
    const d = document.createElement("div");
    d.className = "loading";
    d.innerHTML = '<span class="spinner"></span> Researching leads with Claude…';
    wrap.appendChild(d);
    return;
  }
  if (state.status === "error") {
    showBanner(state.error || "Something went wrong.");
    return;
  }

  (state.results || []).forEach((lead, i) => {
    const card = document.createElement("div");
    card.className = "card";

    const h = document.createElement("h3");
    h.textContent = lead.company || lead.contactName || "Untitled lead";
    card.appendChild(h);

    const metaBits = [lead.contactName && lead.title ? `${lead.contactName} · ${lead.title}` : (lead.contactName || lead.title), lead.location, lead.employeeCount ? lead.employeeCount + " staff" : "", lead.industry]
      .filter(Boolean);
    if (metaBits.length) {
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = metaBits.join("  ·  ");
      card.appendChild(m);
    }

    if (lead.why) {
      const w = document.createElement("p");
      w.className = "why";
      w.textContent = lead.why;
      card.appendChild(w);
    }
    if (lead.signal) {
      const s = document.createElement("p");
      s.className = "signal";
      s.textContent = "▲ " + lead.signal;
      card.appendChild(s);
    }

    const links = document.createElement("div");
    links.className = "links";
    const site = safeUrl(lead.website);
    const src = safeUrl(lead.source);
    if (site) { const a = document.createElement("a"); a.href = site; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = "Website ↗"; links.appendChild(a); }
    if (src) { const a = document.createElement("a"); a.href = src; a.target = "_blank"; a.rel = "noreferrer"; a.textContent = "Source ↗"; links.appendChild(a); }
    if (links.children.length) card.appendChild(links);

    const foot = document.createElement("div");
    foot.className = "card-foot";
    const key = leadKey(lead, i);
    if (savedIds.has(key)) {
      const tag = document.createElement("span");
      tag.className = "saved-tag";
      tag.textContent = "✓ Saved to Karma Connect";
      foot.appendChild(tag);
    } else {
      const btn = document.createElement("button");
      btn.className = "btn ghost sm";
      btn.textContent = "Save to Karma Connect";
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "Saving…";
        const res = await send({ type: "SAVE", lead });
        if (res?.ok) { savedIds.add(key); renderResults(state); showBanner("Saved “" + res.saved.label + "”.", "info"); }
        else { btn.disabled = false; btn.textContent = "Save to Karma Connect"; showBanner(res?.error || "Could not save."); }
      });
      foot.appendChild(btn);
    }
    card.appendChild(foot);
    wrap.appendChild(card);
  });
}

async function refreshAuthUI() {
  const { auth } = await chrome.storage.local.get("auth");
  const signedIn = !!auth?.token;
  $("who").textContent = signedIn ? auth.email : "Not signed in";
  $("signedOut").classList.toggle("hidden", signedIn);
  $("signedIn").classList.toggle("hidden", !signedIn);
  if (signedIn) $("signedInEmail").textContent = auth.email;
}

async function init() {
  const { backendUrl, searchState } = await chrome.storage.local.get(["backendUrl", "searchState"]);
  $("backendUrl").value = backendUrl || "http://localhost:8787";
  await refreshAuthUI();
  if (searchState) renderResults(searchState);

  $("gear").addEventListener("click", () => $("settings").classList.toggle("hidden"));

  $("saveBackend").addEventListener("click", async () => {
    const url = $("backendUrl").value.trim();
    await chrome.storage.local.set({ backendUrl: url });
    showBanner("Backend URL saved.", "info");
  });

  $("signin").addEventListener("click", async () => {
    showBanner("");
    const res = await send({ type: "SIGNIN", email: $("email").value, password: $("password").value });
    if (res?.ok) { $("password").value = ""; await refreshAuthUI(); showBanner("Signed in.", "info"); }
    else showBanner(res?.error || "Sign in failed.");
  });

  $("signout").addEventListener("click", async () => {
    await send({ type: "SIGNOUT" });
    await refreshAuthUI();
    showBanner("Signed out.", "info");
  });

  $("find").addEventListener("click", async () => {
    const query = $("query").value.trim();
    if (!query) { showBanner("Describe the leads you want first."); return; }
    showBanner("");
    savedIds.clear();
    await send({ type: "SEARCH", query, count: $("count").value });
  });

  // Live-update results as the background worker writes progress to storage.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.searchState) {
      showBanner("");
      renderResults(changes.searchState.newValue);
    }
  });
}

init();
