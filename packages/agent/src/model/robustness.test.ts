import { describe, expect, it } from "vitest";
import { parseStructured } from "./loop.js";

describe("parseStructured", () => {
  it("takes the first object when the model emits a second one", () => {
    expect(parseStructured<{ a: number }>('{"a":1}\n{"b":2}')).toEqual({ a: 1 });
  });
  it("ignores braces inside strings and trailing prose", () => {
    expect(parseStructured<{ a: string }>('{"a":"x } y \\" {"} Done.')).toEqual({ a: 'x } y " {' });
  });
  it("still parses fenced and plain JSON", () => {
    expect(parseStructured('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("still rejects text with no object", () => {
    expect(() => parseStructured("no json here")).toThrow("structured JSON");
  });
});
