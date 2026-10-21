// Invitations spread over the week: a weekly target (invitesPerWeek, 80 by default) sent as a
// different number each working day, so the account never sends the same count day after day.
// Owner's rule, 2026-10-21: "maximum 80 invitations a week … a random number per day that sums
// up to 80 per week".
//
// This week's total is itself different every week (weekTarget: 60–80 for 80). Each
// working day's target is what is left of that divided by the working days left
// (today included), varied at random by ±40%, and never more than the day's maximum
// (invitesPerDay). The last working day takes whatever is left. A day the PC was off simply
// leaves more for the days after. The random part is seeded by the account and the date, so a
// day's target is fixed once it starts — it doesn't jump around on every check-in.
//
// The week is Monday to Sunday on the PC's own clock (the worker sends its local day, hour and
// minute). The rolling 7-day cap (decide() in linkedin-agent.cjs) still applies on top.
const crypto = require("crypto");

// 0..1, the same for the same account and day
function seeded(accountId, dayIndex) {
  const h = crypto.createHash("sha256").update(String(accountId) + ":" + dayIndex).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

// localDay: 0 = Sunday … 6 = Saturday. Working days left this week, today included.
function workdaysLeft(localDay, weekdaysOnly) {
  const order = [1, 2, 3, 4, 5, 6, 0];                 // Monday first
  const i = order.indexOf(localDay);
  const rest = order.slice(i);
  return rest.filter((d) => !weekdaysOnly || (d >= 1 && d <= 5)).length;
}

/* Today's invitation target. weekCap: invitesPerWeek; maxPerDay: invitesPerDay; sentBeforeToday:
   invitations already sent this week before today; isWorkday: today counts. */
function dailyTarget({ weekCap, maxPerDay, sentBeforeToday, localDay, weekdaysOnly, accountId, dayIndex }) {
  const isWorkday = !weekdaysOnly || (localDay >= 1 && localDay <= 5);
  if (!isWorkday) return 0;
  const remaining = Math.max(0, weekCap - Math.max(0, sentBeforeToday || 0));
  if (!remaining) return 0;
  const left = Math.max(1, workdaysLeft(localDay, weekdaysOnly));
  if (left === 1) return Math.min(remaining, maxPerDay);          // the last working day: the rest
  const r = 0.6 + 0.8 * seeded(accountId, dayIndex);               // ±40%
  let t = Math.round((remaining / left) * r);
  // the days after can only take maxPerDay each: send enough today that the week can still add up
  t = Math.max(t, remaining - (left - 1) * maxPerDay);
  return Math.max(1, Math.min(t, maxPerDay, remaining));
}

/* This week's total: a different number each week, between three quarters of weekCap and
   weekCap itself (60–80 for 80), never over it. Owner, 2026-10-21: "it should be different
   every week". Seeded by the account and the week, so it holds all week. */
function weekTarget({ weekCap, accountId, weekIndex }) {
  const lo = Math.ceil(weekCap * 0.75);
  return Math.min(weekCap, lo + Math.floor(seeded(accountId, "w" + weekIndex) * (weekCap - lo + 1)));
}

/* Where today and this week began on the PC's clock, from what the worker says its local time is.
   An older worker sends no minute: the server's own minute stands in (off by under an hour at
   most, and only in a :30 / :45 time zone). Returns ms timestamps and a day index for the seed. */
function localBounds({ now = Date.now(), localHour, localDay, localMinute }) {
  const minute = Number.isInteger(localMinute) ? localMinute : new Date(now).getUTCMinutes();
  const sec = new Date(now).getUTCSeconds();
  const todayStart = now - ((localHour * 60 + minute) * 60 + sec) * 1000;
  const weekStart = todayStart - ((localDay + 6) % 7) * 86400e3;  // Monday 00:00
  // a stable label for "this local day" (local midnight is within ±14h of UTC midnight)
  const dayIndex = Math.round(todayStart / 86400e3);
  const weekIndex = dayIndex - ((localDay + 6) % 7);               // the Monday's day index
  return { todayStart, weekStart, dayIndex, weekIndex };
}

module.exports = { dailyTarget, weekTarget, workdaysLeft, localBounds, seeded };
