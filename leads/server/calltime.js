"use strict";
/* Calling hours: is it a decent hour where this lead is?

   US telemarketing rules (TCPA) allow calls between 8am and 9pm in the
   called party's local time. The power dialer rings thousands of leads
   across every US time zone without a person looking at each, so the hour
   is checked here rather than trusted to the rep.

   Where a lead is: its state, else the area code of its phone (where the
   number was issued — a mobile keeps it when its owner moves, which is the
   best there is). A state that spans two zones — Florida's panhandle,
   west Texas — counts as open only when the hour is right in BOTH, which
   costs at most an hour each end of the day and never rings someone at
   7:30am. A lead with no state and no North American number has no known
   zone and is not held back: there is nothing to check it against.

   CALL_HOURS ("8-21") changes the window; the default is the TCPA one. */

const { AREA_REGION } = require("./areacodes");

const [OPEN_H, CLOSE_H] = (() => {
  const m = String(process.env.CALL_HOURS || "").match(/^(\d{1,2})-(\d{1,2})$/);
  const o = m ? +m[1] : 8, c = m ? +m[2] : 21;
  return o >= 0 && c <= 24 && o < c ? [o, c] : [8, 21];
})();

const ET = "America/New_York", CT = "America/Chicago", MT = "America/Denver",
  PT = "America/Los_Angeles", AZ = "America/Phoenix";
const ZONES = {
  AL: [CT], AK: ["America/Anchorage"], AZ: [AZ], AR: [CT], CA: [PT], CO: [MT], CT: [ET],
  DE: [ET], DC: [ET], FL: [ET, CT], GA: [ET], HI: ["Pacific/Honolulu"], ID: [MT, PT],
  IL: [CT], IN: [ET, CT], IA: [CT], KS: [CT, MT], KY: [ET, CT], LA: [CT], ME: [ET],
  MD: [ET], MA: [ET], MI: [ET, CT], MN: [CT], MS: [CT], MO: [CT], MT: [MT], NE: [CT, MT],
  NV: [PT], NH: [ET], NJ: [ET], NM: [MT], NY: [ET], NC: [ET], ND: [CT, MT], OH: [ET],
  OK: [CT], OR: [PT, MT], PA: [ET], RI: [ET], SC: [ET], SD: [CT, MT], TN: [CT, ET],
  TX: [CT, MT], UT: [MT], VT: [ET], VA: [ET], WA: [PT], WV: [ET], WI: [CT], WY: [MT],
  PR: ["America/Puerto_Rico"],
  // Canada
  AB: ["America/Edmonton"], BC: ["America/Vancouver"], MB: ["America/Winnipeg"],
  NB: ["America/Moncton"], NL: ["America/St_Johns"], NS: ["America/Halifax"],
  ON: ["America/Toronto", "America/Winnipeg"], PE: ["America/Halifax"],
  QC: ["America/Toronto"], SK: ["America/Regina"],
};
/* leads.state holds both spellings — "TX" and "Texas" */
const NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", "washington dc": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
  iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "puerto rico": "PR", alberta: "AB", "british columbia": "BC", manitoba: "MB",
  "new brunswick": "NB", newfoundland: "NL", "newfoundland and labrador": "NL",
  "nova scotia": "NS", ontario: "ON", "prince edward island": "PE", quebec: "QC",
  saskatchewan: "SK",
};
const SHORT = { [ET]: "Eastern", [CT]: "Central", [MT]: "Mountain", [PT]: "Pacific", [AZ]: "Arizona" };

function regionOf(state, phone) {
  const s = String(state || "").trim();
  const code = s.length === 2 ? s.toUpperCase() : NAMES[s.toLowerCase()];
  if (code && ZONES[code]) return code;
  // area code: +1 or a bare 10-digit number only
  const raw = String(phone || "").trim();
  let d = raw.replace(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i, "").replace(/\D/g, "");
  if (raw.startsWith("+") && d[0] !== "1") return null;
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  if (d.length < 10) return null;
  const r = AREA_REGION[d.slice(0, 3)];
  return r && ZONES[r] ? r : null;
}

const hourIn = (tz, at) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(at);
  return +p.find((x) => x.type === "hour").value + +p.find((x) => x.type === "minute").value / 60;
};
const openIn = (zones, at) => zones.every((tz) => { const h = hourIn(tz, at); return h >= OPEN_H && h < CLOSE_H; });

/* When every zone is next inside the window, looking ahead in 5-minute steps. */
function nextOpen(zones, from) {
  for (let m = 5; m <= 48 * 60; m += 5) {
    const t = new Date(from.getTime() + m * 60e3);
    if (openIn(zones, t)) return t;
  }
  return null;
}

/* The answer for one lead: { open, region, local, zone, opensAt } —
   open is true when its zone is unknown (nothing to hold it back on). */
function check(lead, at = new Date()) {
  const region = regionOf(lead?.state, lead?.phone);
  if (!region) return { open: true, region: null, local: null, zone: null, opensAt: null };
  const zones = ZONES[region];
  const open = openIn(zones, at);
  const local = new Intl.DateTimeFormat("en-US", { timeZone: zones[0], hour: "numeric", minute: "2-digit" }).format(at);
  return { open, region, local, zone: SHORT[zones[0]] || zones[0].split("/").pop().replace(/_/g, " "),
    opensAt: open ? null : nextOpen(zones, at)?.toISOString() || null };
}

module.exports = { check, regionOf, HOURS: [OPEN_H, CLOSE_H] };
