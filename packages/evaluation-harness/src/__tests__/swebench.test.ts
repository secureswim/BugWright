import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstances, parseInstance } from "../swebench.js";

export const instance = {
  instance_id: "owner__repo-12",
  repo: "owner/repo",
  base_commit: "a".repeat(40),
  problem_statement: "Fix the bug\nDetails",
  hints_text: "",
  test_patch: "gold test",
  patch: "gold fix",
  version: "1",
  FAIL_TO_PASS: '["test_bug"]',
  PASS_TO_PASS: '["test_existing"]',
  environment_setup_commit: "",
};
describe("SWE-bench loader", () => {
  it("validates gold test arrays and commit identity", () => {
    expect(parseInstance(instance)).toEqual(instance);
    for (const invalid of ["{}", "broken", "[123]", '[""]'])
      expect(() => parseInstance({ ...instance, FAIL_TO_PASS: invalid })).toThrow();
    expect(() => parseInstance({ ...instance, base_commit: "main" })).toThrow();
  });
  it("loads JSONL and applies all filters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "swebench-"));
    try {
      const file = path.join(root, "dataset.jsonl");
      await writeFile(
        file,
        [instance, { ...instance, instance_id: "other__repo-13", repo: "other/repo" }]
          .map((item) => JSON.stringify(item))
          .join("\n") + "\n",
      );
      expect(await loadInstances(file, { repo: "owner/repo" })).toEqual([instance]);
      expect(await loadInstances(file, { instanceId: instance.instance_id })).toEqual([instance]);
      expect(await loadInstances(file, { instanceIds: [instance.instance_id] })).toEqual([instance]);
      await writeFile(file, JSON.stringify(instance) + "\ninvalid");
      await expect(loadInstances(file)).rejects.toThrow("line 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
