import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("lowercases the title", () => assert.equal(slugify("Hello"), "hello"));
