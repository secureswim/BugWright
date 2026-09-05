import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/app.js";

test("renders list items", () => assert.equal(render(["a"]), "<li>a</li>"));
