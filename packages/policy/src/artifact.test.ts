import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureArtifact,
  assertArtifactCurrent,
  parseArtifact,
  assertReproductionEditable,
  assertReproduction,
  sha256,
  artifactApprovalHash,
  assertReviewEvidence,
  restoreArtifact,
} from "./artifact.js";
import { resolveInside } from "./index.js";

let root: string;
let base: string;
function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bugwright-integrity-test-"));
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  await writeFile(path.join(root, "source.js"), "export const add = (a,b) => a-b;\n");
  await writeFile(path.join(root, "delete.txt"), "old\n");
  await writeFile(path.join(root, ".gitignore"), "build/\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base");
  base = git("rev-parse", "HEAD");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function reviewed() {
  await writeFile(path.join(root, "repro.test.js"), "assert.equal(add(1,2),3);\n");
  const baseline = await captureArtifact(root, base);
  const proof = {
    path: "repro.test.js",
    sha256: sha256(await readFile(path.join(root, "repro.test.js"))),
    baselineArtifactHash: baseline.hash,
    testRunId: "before",
  };
  await writeFile(path.join(root, "source.js"), "export const add = (a,b) => a+b;\n");
  const artifact = await captureArtifact(root, base, proof);
  const report = { passed: true, reproductionFixed: "passed", artifactHash: artifact.hash };
  const common = { command: "node --test", stdout: "", stderr: "", durationMs: 1 };
  const tests = [
    { ...common, id: "before", artifactHash: baseline.hash, kind: "reproduction-before", exitCode: 1 },
    { ...common, id: "after", artifactHash: artifact.hash, kind: "reproduction-after", exitCode: 0 },
  ];
  return { artifact, report, tests, proof };
}

describe("review artifacts using real Git repositories", { timeout: 20000 }, () => {
  it("captures additions, binary bytes and deletions without touching the index", async () => {
    const indexBefore = await readFile(path.join(root, ".git/index"));
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 255, 128, 1]));
    await rm(path.join(root, "delete.txt"));
    const artifact = await captureArtifact(root, base);
    expect(artifact.files.map((f) => f.path)).toEqual(["binary.dat", "delete.txt"]);
    expect(artifact.files[0].content).toBe(Buffer.from([0, 255, 128, 1]).toString("base64"));
    expect(artifact.files[1].content).toBeNull();
    expect(artifact.diff).toContain("GIT binary patch");
    expect(await readFile(path.join(root, ".git/index"))).toEqual(indexBefore);
    expect(await assertArtifactCurrent(root, artifact)).toEqual(artifact);
  });

  it("captures staged changes and ignores untracked build outputs", async () => {
    await writeFile(path.join(root, "new file.txt"), "new\n");
    git("add", ".");
    await mkdir(path.join(root, "build"));
    await writeFile(path.join(root, "build/generated.js"), "cache");
    const artifact = await captureArtifact(root, base);
    expect(artifact.files.map((f) => f.path)).toEqual(["new file.txt"]);
    await writeFile(path.join(root, "build/generated.js"), "updated cache");
    await expect(assertArtifactCurrent(root, artifact)).resolves.toBeDefined();
  });

  it("preserves a diff beyond the previous 200,000-character truncation limit", async () => {
    await writeFile(path.join(root, "large.txt"), "0123456789".repeat(30000) + "END_OF_ARTIFACT\n");
    const artifact = await captureArtifact(root, base);
    expect(artifact.diff.length).toBeGreaterThan(200000);
    expect(artifact.diff).toContain("END_OF_ARTIFACT");
  });

  it("fails explicitly on oversized files", async () => {
    await writeFile(path.join(root, "oversized.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(captureArtifact(root, base)).rejects.toThrow(/8 MiB/);
  });

  it("detects a change to previously unchanged source", async () => {
    const artifact = await captureArtifact(root, base);
    await writeFile(path.join(root, "source.js"), "changed\n");
    await expect(assertArtifactCurrent(root, artifact)).rejects.toThrow(/Source changed/);
  });

  it("detects untracked-file addition after approval", async () => {
    const { artifact } = await reviewed();
    await writeFile(path.join(root, "unexpected.js"), "extra");
    await expect(assertArtifactCurrent(root, artifact)).rejects.toThrow(/Source changed/);
  });

  it("restores a crash-damaged workspace to the exact verified checkpoint", async () => {
    const { artifact } = await reviewed();
    await writeFile(path.join(root, "source.js"), "partial worker output\n");
    await rm(path.join(root, "repro.test.js"));
    await writeFile(path.join(root, "unexpected.js"), "stale partial file\n");

    await expect(restoreArtifact(root, artifact)).resolves.toEqual(artifact);
    expect(await readFile(path.join(root, "source.js"), "utf8")).toBe("export const add = (a,b) => a+b;\n");
    expect(await readFile(path.join(root, "repro.test.js"), "utf8")).toBe("assert.equal(add(1,2),3);\n");
    await expect(readFile(path.join(root, "unexpected.js"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects base-commit changes", async () => {
    const artifact = await captureArtifact(root, base);
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "other",
    );
    await expect(assertArtifactCurrent(root, artifact)).rejects.toThrow(/Base commit changed/);
  });

  it("retains executable modes", async () => {
    git("update-index", "--chmod=+x", "source.js");
    git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "executable");
    base = git("rev-parse", "HEAD");
    await writeFile(path.join(root, "source.js"), "new source\n");
    if (process.platform !== "win32") await chmod(path.join(root, "source.js"), 0o755);
    expect((await captureArtifact(root, base)).files[0].mode).toBe("100755");
  });

  it("survives JSONB-style recursive object-key reordering", async () => {
    const { artifact } = await reviewed();
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reorder(v)]),
            )
          : value;
    const stored = JSON.parse(JSON.stringify(reorder(artifact)));
    expect(parseArtifact(stored).hash).toBe(artifact.hash);
    await expect(assertArtifactCurrent(root, stored)).resolves.toBeDefined();
  });

  it("rejects artifact-content tampering and legacy artifacts", async () => {
    const { artifact } = await reviewed();
    artifact.files[0].content = "YXR0YWNr";
    expect(() => parseArtifact(artifact)).toThrow(/fingerprint/);
    expect(() => parseArtifact(null)).toThrow(/versioned/);
  });

  it("blocks directory junctions/symlinks at reads, new writes and capture", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "bugwright-outside-test-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "not source");
      await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
      expect(() => resolveInside(root, "escape/secret.txt")).toThrow(/Symlink/);
      expect(() => resolveInside(root, "escape/new.txt")).toThrow(/Symlink/);
      await expect(captureArtifact(root, base)).rejects.toThrow(/Symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects hardlinked reproduction/source aliases", async () => {
    await link(path.join(root, "source.js"), path.join(root, "alias.js"));
    await expect(captureArtifact(root, base)).rejects.toThrow(/hardlinked/);
  });
});

describe("evidence and authorization", { timeout: 20000 }, () => {
  it("protects the reproduction path regardless of case and checks its bytes", async () => {
    const { proof } = await reviewed();
    expect(() => assertReproductionEditable("REPRO.test.js", proof.path)).toThrow(/protected/);
    expect(assertReproductionEditable("source.js", proof.path)).toBe("source.js");
    await writeFile(path.join(root, proof.path), "assert.ok(true)");
    await expect(assertReproduction(root, proof)).rejects.toThrow(/changed/);
  });

  it.each([undefined, "not-run", "not-configured", "failed"])(
    "rejects reproduction result %s",
    async (result) => {
      const { artifact, report, tests } = await reviewed();
      expect(() => assertReviewEvidence(artifact, { ...report, reproductionFixed: result }, tests)).toThrow();
    },
  );

  it("rejects evidence from another artifact or with no failing baseline", async () => {
    const { artifact, report, tests } = await reviewed();
    expect(() => assertReviewEvidence(artifact, { ...report, artifactHash: "other" }, tests)).toThrow();
    expect(() => assertReviewEvidence(artifact, report, tests.slice(1))).toThrow(/baseline/);
    expect(() =>
      assertReviewEvidence(artifact, report, [tests[0], { ...tests[1], artifactHash: "other" }]),
    ).toThrow(/Passing/);
  });

  it("binds approval to evidence and destination while ignoring query order", async () => {
    const { artifact, report, tests } = await reviewed();
    const input = {
      taskId: "task",
      repository: "https://github.com/example/repo",
      targetBranch: "main",
      artifact,
      report,
      tests,
    };
    const hash = artifactApprovalHash(input);
    expect(artifactApprovalHash({ ...input, tests: [...tests].reverse() })).toBe(hash);
    expect(artifactApprovalHash({ ...input, targetBranch: "other" })).not.toBe(hash);
    expect(
      artifactApprovalHash({ ...input, tests: tests.map((t) => ({ ...t, stdout: "changed" })) }),
    ).not.toBe(hash);
  });
});
