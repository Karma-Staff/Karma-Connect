import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { buildPrompt, parseBrief, normalise, isEmpty } = require("./brief.js");

/* These tests are all about one failure: a briefing reaching a rep with
   something in it that the model did not actually find, or that renders as
   junk on screen while they are dialling. */

describe("parseBrief", () => {
  it("reads a bare JSON object", () => {
    expect(parseBrief('{"headline":"x"}')).toEqual({ headline: "x" });
  });

  it("digs the object out of a fenced or chatty reply", () => {
    // both shapes observed from real models often enough to matter
    expect(parseBrief('```json\n{"headline":"x"}\n```')).toEqual({ headline: "x" });
    expect(parseBrief('Here is what I found:\n{"headline":"x"}\nHope that helps!'))
      .toEqual({ headline: "x" });
  });

  it("returns null rather than throwing on anything unparseable", () => {
    for (const bad of ["", null, undefined, "no json here", "{broken", "{'single':1}"])
      expect(parseBrief(bad)).toBeNull();
  });
});

describe("normalise", () => {
  it("survives null, and yields a fully-formed empty briefing", () => {
    const b = normalise(null);
    expect(b.headline).toBe("");
    expect(b.recentSignals).toEqual([]);
    expect(b.person.education).toBe("");
    expect(isEmpty(b)).toBe(true);
  });

  it("drops values of the wrong type instead of rendering them", () => {
    const b = normalise({
      headline: { oops: 1 },            // object where a string was asked for
      whatTheyDo: ["a", "b"],           // array where a string was asked for
      recentSignals: "not an array",
      person: "not an object",
      talkingPoints: [null, 42, "a real one", { x: 1 }],
    });
    expect(b.headline).toBe("");
    expect(b.whatTheyDo).toBe("");
    expect(b.recentSignals).toEqual([]);
    expect(b.person.role).toBe("");
    expect(b.talkingPoints).toEqual(["a real one"]);
  });

  it("caps every list so one runaway answer cannot fill the pane", () => {
    const many = Array.from({ length: 20 }, (_, i) => "item " + i);
    const b = normalise({ recentSignals: many, congratulations: many,
      talkingPoints: many, avoid: many, person: { interests: many } });
    expect(b.recentSignals).toHaveLength(3);
    expect(b.congratulations).toHaveLength(2);
    expect(b.talkingPoints).toHaveLength(4);
    expect(b.avoid).toHaveLength(2);
    expect(b.person.interests).toHaveLength(5);
  });

  it("keeps only real http(s) sources", () => {
    const b = normalise({ sources: [
      "https://example.com/a", "http://example.com/b",
      "javascript:alert(1)", "not a url", "ftp://example.com/c",
    ] });
    expect(b.sources).toEqual(["https://example.com/a", "http://example.com/b"]);
  });

  it("only accepts the three confidence values", () => {
    expect(normalise({ confidence: "high" }).confidence).toBe("high");
    expect(normalise({ confidence: "very sure" }).confidence).toBe("");
    expect(normalise({ confidence: 9 }).confidence).toBe("");
  });

  it("counts a briefing with nothing but a confidence rating as empty", () => {
    // the model answering "low" and nothing else must not be saved as a find
    expect(isEmpty(normalise({ confidence: "low", sources: ["https://x.com"] }))).toBe(true);
  });
});

describe("buildPrompt", () => {
  const co = { kind: "company", company: "SERVPRO of Tulsa", contact: "Dana Reed",
    website: "https://example.com", city: "Tulsa", state: "OK", industry: "Restoration" };

  it("asks about the company for a company row, and names the contact", () => {
    const { prompt, person } = buildPrompt(co);
    expect(person).toBe(false);
    expect(prompt).toContain("Research THIS COMPANY");
    expect(prompt).toContain("SERVPRO of Tulsa");
    expect(prompt).toContain("Named contact at the company: Dana Reed");
  });

  it("asks about the individual for a person row", () => {
    const { prompt, person } = buildPrompt({ ...co, kind: "person", name: "Dana Reed" });
    expect(person).toBe(true);
    expect(prompt).toContain("Research THIS PERSON");
    expect(prompt).not.toContain("Named contact at the company");
  });

  it("leaves out fields the lead does not have, rather than sending blanks", () => {
    const { prompt } = buildPrompt({ kind: "company", company: "Acme" });
    expect(prompt).not.toContain("Website:");
    expect(prompt).not.toContain("Location:");
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  it("tells the model an empty field is an acceptable answer", () => {
    // the whole defence against a fabricated alma mater rests on this
    const { prompt } = buildPrompt(co);
    expect(prompt).toMatch(/return \[\]|Leave the whole object/i);
  });
});
