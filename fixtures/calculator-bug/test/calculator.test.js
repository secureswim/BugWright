import test from "node:test";
import assert from "node:assert/strict";
import { add, multiply } from "../src/calculator.js";

test("adds positive and negative numbers", () => {
  assert.equal(add(4, 3), 7);
  assert.equal(add(-2, 5), 3);
});

test("multiplies numbers", () => assert.equal(multiply(4, 3), 12));
