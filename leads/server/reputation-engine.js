"use strict";
/* The Karma Connect Risk Score, and the rules for reading provider answers.
 *
 * Pure: no database, no network. reputation.js gathers the inputs (the
 * RingCentral call log, our own call log, the number list) and stores what
 * comes out; everything that decides a score or a status lives here, where
 * it can be tested on its own.
 *
 * WHAT THIS SCORE IS. Our own reading of how a number has been used: volume,
 * answer rate, how often people hang up straight away, repeat dialling,
 * opt-outs. Those are the behaviours carriers' analytics engines punish, so
 * a high score is a reason to look — but it is OUR assessment, labelled as
 * such everywhere, and never presented as a carrier spam label.
 *
 * WHAT IT IS NOT. It cannot see whether a number is labelled "Spam Likely":
 * that lives with Hiya / First Orion / TNS, behind paid, authorised feeds.
 * Signals only a provider could answer are reported as "unknown" — never as
 * "not detected", because no evidence is not evidence of none.
 *
 * Every point on the score is attached to the signal that earned it, so the
 * screen can always say why. */

const CONNECTED = new Set(["Accepted", "Call connected"]);
const DAY = 864e5;

/* Bands for the internal score. Admin-adjustable alert threshold lives in
   settings; the bands themselves are fixed so a "High" means the same thing
   on every screen and in every email. */
const BANDS = [
  { max: 29, key: "low", label: "Low" },
  { max: 59, key: "moderate", label: "Moderate" },
  { max: 79, key: "high", label: "High" },
  { max: 100, key: "critical", label: "Critical" },
];
const bandOf = (score) => BANDS.find((b) => score <= b.max) || BANDS[BANDS.length - 1];

/* The verified status a provider can report, in order of severity. */
const VERIFIED = {
  good: { label: "Good", spam: false },
  at_risk: { label: "At risk", spam: false },
  potentially_flagged: { label: "Potentially flagged", spam: null },
  flagged: { label: "Flagged as spam", spam: true },
  unknown: { label: "Unable to determine", spam: null },
};

/* Hiya's four labelling states (its Number Reputation API), mapped onto ours.
   Anything we do not recognise is "unknown" — a value we cannot read is not
   a clean bill of health. */
const HIYA_STATUS = {
  flagged: "flagged",
  mixed_high: "potentially_flagged",
  mixed_low: "at_risk",
  unflagged: "good",
};
function readProviderStatus(raw) {
  const k = String(raw || "").trim().toLowerCase();
  return HIYA_STATUS[k] || (VERIFIED[k] ? k : "unknown");
}

const digits10 = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/* Numbers that place calls. Fax lines are not checked — no one is labelled
   spam for sending a fax, and listing them would only add noise. */
const isVoiceNumber = (n) => !/fax/i.test(n.usage || "");

/* The signals a provider would have to supply. Listed so the screen can show
   them honestly as unknown rather than leaving them out. */
const PROVIDER_ONLY = [
  ["spam_complaints", "Spam complaints"],
  ["scam_reports", "Scam reports"],
  ["callerid_reputation", "Caller ID reputation"],
  ["number_age", "Number age"],
  ["registration", "Number registration status"],
  ["carrier_reputation", "Carrier reputation"],
  ["third_party", "Third-party reputation data"],
];

/* ---------------- the score ----------------

   inputs
     number   { number, usage, status, callerIdName }
     calls    RingCentral call-log records for the whole account, last 14
              days: { t, dur, dir, res, fromNum, toNum }
     ours     our own logged calls with a disposition, last 7 days:
              { at, number, disposition }
     now      ms
     share    this number's share of the account's outbound calls (0..1)

   Each signal: { key, label, state, value, detail, points }
     state: detected | not_detected | unknown | verified */
function assess({ number, calls, ours = [], now = Date.now(), share = 0, verified = null }) {
  const me = digits10(number.number);
  const out = calls.filter((c) => c.dir === "Outbound" && digits10(c.fromNum) === me);
  const recent = out.filter((c) => c.t >= now - 7 * DAY);
  const base = out.filter((c) => c.t < now - 7 * DAY && c.t >= now - 14 * DAY);
  const connected = recent.filter((c) => CONNECTED.has(c.res));
  const signals = [];
  const add = (key, label, state, value, detail, points = 0) =>
    signals.push({ key, label, state, value, detail, points: state === "detected" ? points : 0 });
  const few = recent.length < 20;
  const fewNote = `Only ${recent.length} outbound call${recent.length === 1 ? "" : "s"} from this number in 7 days — too few to judge.`;

  /* 1. Call-volume anomaly: a sudden burst is the classic robocaller shape. */
  {
    const perDay = new Map();
    for (const c of recent) {
      const d = Math.floor((c.t - (now - 7 * DAY)) / DAY);
      perDay.set(d, (perDay.get(d) || 0) + 1);
    }
    const peak = Math.max(0, ...perDay.values());
    const spike = base.length > 0 && recent.length >= 60 && recent.length >= 3 * base.length;
    const burst = peak >= 150;
    const value = `${recent.length} this week · ${base.length} the week before${peak ? ` · busiest day ${peak}` : ""}`;
    if (spike || burst)
      add("volume_anomaly", "Call-volume anomaly", "detected", value,
        spike ? "Outbound calls jumped to three times the previous week or more."
          : "More than 150 calls in a single day from one number.", spike && burst ? 25 : 15);
    else add("volume_anomaly", "Call-volume anomaly", "not_detected", value, "Volume is in line with the previous week.");
  }

  /* 2. Answer rate. A number that suddenly stops being answered is often
     already being labelled — the strongest signal we can see ourselves. */
  if (few) add("answer_rate", "Answer rate", "unknown", `${recent.length} calls`, fewNote);
  else {
    const r = pct(connected.length, recent.length);
    const value = `${r}% (${connected.length} of ${recent.length})`;
    if (r < 10) add("answer_rate", "Answer rate", "detected", value, "Fewer than 1 in 10 calls are answered — consistent with a spam label on recipients' phones.", 25);
    else if (r < 20) add("answer_rate", "Answer rate", "detected", value, "Fewer than 1 in 5 calls are answered.", 15);
    else if (r < 30) add("answer_rate", "Answer rate", "detected", value, "Below 30% answered.", 5);
    else add("answer_rate", "Answer rate", "not_detected", value, "A healthy share of calls are answered. (RingCentral counts a call picked up by voicemail as answered, so this reads on the high side.)");
  }

  /* 3. Short-call ratio: answered, then hung up within ten seconds — people
     who saw the caller ID, or heard the first words, and decided. */
  if (connected.length < 10) add("short_call_ratio", "Short-call ratio", "unknown", `${connected.length} answered`, "Too few answered calls to judge.");
  else {
    const short = connected.filter((c) => c.dur <= 10).length;
    const r = pct(short, connected.length);
    const value = `${r}% of answered calls under 10s (${short} of ${connected.length})`;
    if (r >= 50) add("short_call_ratio", "Short-call ratio", "detected", value, "Half or more of answered calls end within ten seconds.", 20);
    else if (r >= 35) add("short_call_ratio", "Short-call ratio", "detected", value, "Many answered calls end within ten seconds.", 10);
    else add("short_call_ratio", "Short-call ratio", "not_detected", value, "Most answered calls last long enough to be conversations.");
  }

  /* 4. Abandonment: we hung up within five seconds, before anyone answered.
     Analytics engines read flash-dialling as automated calling. */
  if (few) add("abandonment", "Call abandonment rate", "unknown", `${recent.length} calls`, fewNote);
  else {
    const ab = recent.filter((c) => !CONNECTED.has(c.res) && c.dur <= 5).length;
    const r = pct(ab, recent.length);
    const value = `${r}% (${ab} of ${recent.length}) ended unanswered within 5s`;
    if (r >= 40) add("abandonment", "Call abandonment rate", "detected", value, "Many calls are cut off within seconds of dialling.", 10);
    else add("abandonment", "Call abandonment rate", "not_detected", value, "Calls are given time to ring.");
  }

  /* 5. Repeated calls: the same person three or more times in 24 hours. */
  {
    const byTo = new Map();
    for (const c of recent) {
      const k = digits10(c.toNum);
      if (!k) continue;
      (byTo.get(k) || byTo.set(k, []).get(k)).push(c.t);
    }
    let hammered = 0;
    for (const ts of byTo.values()) {
      ts.sort((a, b) => a - b);
      for (let i = 2; i < ts.length; i++) if (ts[i] - ts[i - 2] <= DAY) { hammered++; break; }
    }
    const value = `${hammered} contact${hammered === 1 ? "" : "s"} called 3+ times in a day`;
    if (hammered >= 5) add("repeated_calls", "Repeated-call behaviour", "detected", value, "Several people were called three or more times within 24 hours.", 15);
    else if (hammered >= 1) add("repeated_calls", "Repeated-call behaviour", "detected", value, "Someone was called three or more times within 24 hours.", 5);
    else add("repeated_calls", "Repeated-call behaviour", "not_detected", value, "No one was called three times in a day.");
  }

  /* 6. Calls to people never called before. Cold calling is the job here, so
     this weighs little — it matters only alongside the signals above. */
  if (few) add("new_contacts", "Calls to new contacts", "unknown", `${recent.length} calls`, fewNote);
  else {
    const seen = new Set(calls.filter((c) => c.dir === "Outbound" && c.t < now - 7 * DAY).map((c) => digits10(c.toNum)));
    const fresh = new Set(recent.map((c) => digits10(c.toNum)).filter((k) => k && !seen.has(k)));
    const distinct = new Set(recent.map((c) => digits10(c.toNum)).filter(Boolean)).size;
    const r = pct(fresh.size, distinct);
    const value = `${r}% of ${distinct} people called had not been called before`;
    if (r >= 95 && recent.length >= 50)
      add("new_contacts", "Calls to new contacts", "detected", value, "Almost every call goes to someone never called before.", 5);
    else add("new_contacts", "Calls to new contacts", "not_detected", value, "A normal mix of new and returning contacts.");
  }

  /* 7. Opt-outs: reps marking "Do Not Contact" on calls from this number.
     Our own log holds the disposition; RingCentral's says which number the
     call went out as — they are joined on the number called and the time. */
  {
    const dispo = ours.filter((o) => o.disposition);
    const mine = dispo.filter((o) => recent.some((c) =>
      digits10(c.toNum) === digits10(o.number) && Math.abs(c.t + c.dur * 1000 - o.at) < 5 * 60e3));
    if (mine.length < 10) add("opt_outs", "Opt-out rate", "unknown", `${mine.length} dispositioned`, "Too few dispositioned calls from this number to judge.");
    else {
      const dnc = mine.filter((o) => o.disposition === "DNC" || o.disposition === "Do Not Contact").length;
      const r = pct(dnc, mine.length);
      const value = `${r}% (${dnc} of ${mine.length}) marked Do Not Contact`;
      if (r >= 5) add("opt_outs", "Opt-out rate", "detected", value, "One in twenty or more calls ends in a do-not-contact request.", 15);
      else if (r >= 2) add("opt_outs", "Opt-out rate", "detected", value, "Some calls end in do-not-contact requests.", 5);
      else add("opt_outs", "Opt-out rate", "not_detected", value, "Do-not-contact requests are rare.");
    }
  }

  /* 8. Caller-ID set-up in RingCentral. */
  {
    const problems = [];
    let pts = 0;
    if (number.status && number.status !== "Normal") { problems.push(`RingCentral lists this number as "${number.status}".`); pts += 10; }
    if (!String(number.callerIdName || "").trim()) { problems.push("No caller ID name (CNAM) set — recipients see a bare number."); pts += 5; }
    if (share >= 0.6 && recent.length >= 200) { problems.push(`Carries ${Math.round(share * 100)}% of the company's outbound calls — one number doing most of the dialling wears out fastest.`); pts += 10; }
    if (problems.length) add("callerid_config", "Caller-ID configuration", "detected", problems.length + " issue" + (problems.length === 1 ? "" : "s"), problems.join(" "), pts);
    else add("callerid_config", "Caller-ID configuration", "not_detected", "No issues", "Caller ID name is set and the number is active.");
  }

  /* What only a provider could tell us. With one connected, its answer is
     "verified"; without, these are unknown — and say so. */
  for (const [key, label] of PROVIDER_ONLY) {
    const v = verified && verified[key];
    if (v) signals.push({ key, label, state: "verified", value: v.value, detail: v.detail || "", points: 0, source: v.source });
    else signals.push({ key, label, state: "unknown", value: "Unknown", detail: "Needs an authorised caller-reputation provider — not available from RingCentral.", points: 0 });
  }

  const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
  const band = bandOf(score);
  /* How much the score can be trusted is mostly how much calling it saw. */
  const confidence = recent.length >= 100 ? 0.8 : recent.length >= 20 ? 0.6 : 0.3;
  return {
    score, band: band.key, bandLabel: band.label, confidence,
    signals,
    volume: { recent: recent.length, previous: base.length, answered: connected.length },
  };
}

module.exports = { assess, bandOf, BANDS, VERIFIED, readProviderStatus, isVoiceNumber, digits10, CONNECTED, PROVIDER_ONLY };
