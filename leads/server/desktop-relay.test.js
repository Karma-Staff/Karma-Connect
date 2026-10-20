import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";

/* desktop-relay.js requires auth.js, which pulls in db.js — that refuses to
   load without a connection string. Nothing here queries; a dummy URL lets the
   module load and the lazy pg Pool never connects. */
process.env.DATABASE_URL ||= "postgres://u:p@localhost:5432/test";

const require = createRequire(import.meta.url);
const { createRelay, cleanCall, cleanEvent } = require("./desktop-relay.js");

describe("desktop relay: browser → app", () => {
  let t, relay;
  beforeEach(() => { vi.useFakeTimers(); t = 1_000_000; relay = createRelay({ now: () => t }); });
  afterEach(() => vi.useRealTimers());

  it("refuses a call when no app is online", () => {
    expect(relay.call(7, { number: "+15551234567" })).toBeNull();
    expect(relay.status(7)).toMatchObject({ online: false, registered: false });
  });

  it("hands a call straight to a waiting app", () => {
    const got = [];
    relay.wait(7, { registered: true }, (calls) => got.push(calls));
    expect(relay.status(7)).toMatchObject({ online: true, registered: true });
    const c = relay.call(7, { number: "+15551234567", leadId: 3 });
    expect(c).toBeTruthy();
    expect(got).toEqual([[expect.objectContaining({ id: c.id, number: "+15551234567", leadId: 3 })]]);
  });

  it("keeps a call for the app's next poll, but never rings it late", () => {
    const first = [];
    relay.wait(7, { registered: true }, (calls) => first.push(calls), 1000);
    vi.advanceTimersByTime(1000);                // the poll timed out, empty
    expect(first).toEqual([[]]);
    expect(relay.call(7, { number: "+15550000001" })).toBeTruthy();   // still online (just seen)
    const next = [];
    relay.wait(7, { registered: true }, (calls) => next.push(calls));
    expect(next[0]).toHaveLength(1);

    relay.wait(7, { registered: true }, () => {}, 1000);
    vi.advanceTimersByTime(1000);
    relay.call(7, { number: "+15550000002" });
    t += 21 * 1000;                               // the app comes back too late
    const late = [];
    relay.wait(7, { registered: true }, (calls) => late.push(calls), 1000);
    vi.advanceTimersByTime(1000);
    expect(late).toEqual([[]]);
  });

  it("goes offline once the app stops polling", () => {
    const drop = relay.wait(7, { registered: true }, () => {});
    drop();                                       // the request closed
    expect(relay.status(7).online).toBe(true);    // just seen
    t += 41 * 1000;
    expect(relay.status(7).online).toBe(false);
    expect(relay.call(7, { number: "+15551234567" })).toBeNull();
  });

  it("keeps each person's calls to their own app", () => {
    const mine = [], theirs = [];
    relay.wait(7, { registered: true }, (c) => mine.push(c));
    relay.wait(8, { registered: true }, (c) => theirs.push(c));
    relay.call(7, { number: "+15551234567" });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("an app whose phone isn't registered is online but not ready", () => {
    relay.wait(7, { registered: false }, () => {});
    expect(relay.status(7)).toMatchObject({ online: true, registered: false });
  });
});

describe("desktop relay: app → browser", () => {
  let t, relay;
  beforeEach(() => { vi.useFakeTimers(); t = 1_000_000; relay = createRelay({ now: () => t }); });
  afterEach(() => vi.useRealTimers());

  it("a fresh browser gets the cursor, not old news", () => {
    relay.event(7, { kind: "ended", leadId: 3, outcome: "connected" });
    const got = [];
    relay.events(7, -1, (events, seq) => got.push({ events, seq }));
    expect(got).toEqual([{ events: [], seq: 1 }]);
  });

  it("wakes a waiting browser with what the app reported", () => {
    const got = [];
    relay.events(7, 0, (events, seq) => got.push({ events, seq }));
    relay.event(7, { kind: "ended", leadId: 3, outcome: "busy" });
    expect(got).toEqual([{ events: [expect.objectContaining({ kind: "ended", outcome: "busy", seq: 1 })], seq: 1 }]);
    const later = [];
    relay.event(7, { kind: "wrapped", leadId: 3, label: "VM" });
    relay.events(7, 1, (events) => later.push(events));
    expect(later[0].map((e) => e.kind)).toEqual(["wrapped"]);
  });

  it("a cursor from before a server restart resets instead of hanging", () => {
    const got = [];
    relay.events(7, 99, (events, seq) => got.push({ events, seq }));
    expect(got).toEqual([{ events: [], seq: 0 }]);
  });
});

describe("desktop relay: what is accepted", () => {
  it("takes a phone number and trims the rest", () => {
    expect(cleanCall({ number: "+1 (555) 123-4567", name: "Jane", leadId: 12 }))
      .toEqual({ number: "+15551234567", name: "Jane", leadId: 12, campaign: null });
    expect(cleanCall({ number: "+15551234567", leadId: -4, campaign: { name: "Oct list", callback: { number: "+1 555 000 1111", ext: "101" } } }).campaign)
      .toEqual({ name: "Oct list", callback: { number: "+15550001111", ext: "101" } });
  });

  it("refuses anything that isn't a phone number", () => {
    expect(cleanCall({ number: "" })).toBeNull();
    expect(cleanCall({ number: "javascript:alert(1)" })).toBeNull();
    expect(cleanCall({ number: "12" })).toBeNull();
    expect(cleanCall({ number: "+1234567890123456789" })).toBeNull();
    expect(cleanCall({ number: "+15551234567", leadId: "3" }).leadId).toBeNull();
  });

  it("only knows its four events", () => {
    expect(cleanEvent({ kind: "hangup" })).toBeNull();
    expect(cleanEvent({ kind: "ended", leadId: 3, outcome: "weird" })).toMatchObject({ outcome: "no-answer" });
    expect(cleanEvent({ kind: "wrapped", leadId: 3, label: "VM", note: "left a message" }))
      .toMatchObject({ kind: "wrapped", label: "VM", note: "left a message" });
  });
});
