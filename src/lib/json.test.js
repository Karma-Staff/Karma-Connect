import { describe, it, expect } from "vitest";
import { safeJSON, repairJSON, extractObjects } from "./json.js";

describe("safeJSON", () => {
  it("parses clean JSON", () => {
    expect(safeJSON('{"a":1}')).toEqual({ a: 1 });
    expect(safeJSON('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it("strips ```json code fences", () => {
    expect(safeJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(safeJSON('```\n[{"x":2}]\n```')).toEqual([{ x: 2 }]);
  });

  it("repairs trailing commas", () => {
    expect(safeJSON('{"a":1,}')).toEqual({ a: 1 });
    expect(safeJSON('[1,2,]')).toEqual([1, 2]);
  });

  it("repairs unescaped newlines inside strings", () => {
    expect(safeJSON('{"msg":"line one\nline two"}')).toEqual({ msg: "line one\nline two" });
  });

  it("slices JSON out of surrounding preamble/commentary", () => {
    expect(safeJSON('Here you go:\n{"ok":true}\nHope that helps')).toEqual({ ok: true });
  });

  it("salvages multiple objects from noisy text", () => {
    const out = safeJSON('noise {"a":1} junk {"b":2} end');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws on empty input", () => {
    expect(() => safeJSON("")).toThrow();
  });

  it("throws a descriptive error when nothing is parseable", () => {
    expect(() => safeJSON("totally not json")).toThrow(/malformed/i);
  });
});

describe("repairJSON", () => {
  it("removes trailing commas before } and ]", () => {
    expect(JSON.parse(repairJSON('{"a":1,"b":[2,3,],}'))).toEqual({ a: 1, b: [2, 3] });
  });
});

describe("extractObjects", () => {
  it("extracts top-level objects, ignoring braces inside strings", () => {
    const out = extractObjects('{"a":"has } brace"} {"b":2}');
    expect(out).toEqual([{ a: "has } brace" }, { b: 2 }]);
  });
});
