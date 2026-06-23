import { describe, it, expect } from "vitest";
import { stripHyphens, cleanMessages, stripLinkedInNoise } from "./text.js";

describe("stripHyphens", () => {
  it("replaces an em dash between words with a comma", () => {
    expect(stripHyphens("clean books — faster billing")).toBe("clean books, faster billing");
  });

  it("replaces a spaced hyphen separator with a comma", () => {
    expect(stripHyphens("crews - estimates - admin")).toBe("crews, estimates, admin");
  });

  it("replaces a double hyphen with a comma", () => {
    expect(stripHyphens("books--billing")).toBe("books, billing");
  });

  it("keeps standard compound adjectives intact", () => {
    expect(stripHyphens("full-time well-known support")).toBe("full-time well-known support");
  });

  it("collapses doubled commas and extra spaces", () => {
    expect(stripHyphens("a  —  b")).toBe("a, b");
  });

  it("keeps the blank line between paragraphs (no run-on)", () => {
    expect(stripHyphens("Hi Jeremy,\n\nGreat to connect.\n\nBest, Sam"))
      .toBe("Hi Jeremy,\n\nGreat to connect.\n\nBest, Sam");
  });

  it("keeps single line breaks but collapses horizontal whitespace", () => {
    expect(stripHyphens("Line one\nLine    two")).toBe("Line one\nLine two");
  });

  it("caps 3+ blank lines at one and normalizes CRLF", () => {
    expect(stripHyphens("a  \r\n\r\n\r\n\r\nb")).toBe("a\n\nb");
  });
});

describe("cleanMessages", () => {
  it("strips hyphens from message/reasoning/fresh/persona fields", () => {
    const out = cleanMessages([{ message: "a — b", reasoning: "c - d", angle: "keep-as-is" }]);
    expect(out[0].message).toBe("a, b");
    expect(out[0].reasoning).toBe("c, d");
    expect(out[0].angle).toBe("keep-as-is"); // non-target field untouched
  });

  it("handles a single object as well as arrays", () => {
    expect(cleanMessages({ persona: "x — y" }).persona).toBe("x, y");
  });
});

describe("stripLinkedInNoise", () => {
  it("drops common nav/UI chrome lines", () => {
    const raw = ["Skip to main content", "My Network", "John Doe", "Connect", "Owner at Acme Restoration"].join("\n");
    const out = stripLinkedInNoise(raw);
    expect(out).toContain("John Doe");
    expect(out).toContain("Owner at Acme Restoration");
    expect(out).not.toMatch(/My Network/);
    expect(out).not.toMatch(/Skip to main/);
  });

  it("collapses runs of blank lines", () => {
    expect(stripLinkedInNoise("Real line\n\n\n\nAnother real line")).toBe("Real line\n\nAnother real line");
  });
});
