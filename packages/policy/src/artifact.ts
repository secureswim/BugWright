import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertSafeRelativePath, resolveInside } from "./index.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// PostgreSQL JSONB reorders object keys. Fingerprints must survive that round trip.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export interface ReproductionProof {
  path: string;
  sha256: string;
  baselineArtifactHash: string;
  testRunId: string;
}
interface ArtifactFile {
  path: string;
  mode: "100644" | "100755";
  content: string | null;
  sha256: string | null;
}
export interface ReviewArtifact {
  version: 1;
  baseCommit: string;
  tree: string;
  sourceHash: string;
  reproduction: ReproductionProof | null;
  files: ArtifactFile[];
  diff: string;
  hash: string;
}

async function git(root: string, args: string[], index?: string, input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      {
        cwd: root,
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: MAX_BYTES,
        env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export function assertReproductionEditable(requested: string, protectedPath?: string) {
  const safe = assertSafeRelativePath(requested);
  if (protectedPath && safe.toLowerCase() === assertSafeRelativePath(protectedPath).toLowerCase()) {
    throw new Error("The established reproduction test is protected");
  }
  return safe;
}

export async function assertReproduction(root: string, proof: ReproductionProof) {
  const content = await readFile(resolveInside(root, assertSafeRelativePath(proof.path)));
  if (sha256(content) !== proof.sha256) throw new Error("The established reproduction test changed");
}

/** Capture raw working-tree bytes using a private index. Never stages the user's
 * index and never runs repository clean/smudge filters. Explicit limits fail
 * closed. Ignored, untracked build/dependency outputs are outside the snapshot. */
export async function captureArtifact(
  root: string,
  baseCommit: string,
  reproduction: ReproductionProof | null = null,
): Promise<ReviewArtifact> {
  resolveInside(root, ".git");
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("Only SHA-1 Git base commits are supported");
  if ((await git(root, ["rev-parse", "HEAD"])).toString().trim() !== baseCommit)
    throw new Error("Base commit changed");
  if (reproduction) await assertReproduction(root, reproduction);
  const base = new Map<string, { mode: ArtifactFile["mode"]; oid: string }>();
  for (const line of (await git(root, ["ls-tree", "-rz", baseCommit]))
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755"].includes(mode))
      throw new Error("Symlinks and submodules are unsupported");
    base.set(assertSafeRelativePath(line.slice(tab + 1)), { mode: mode as ArtifactFile["mode"], oid });
  }
  const paths = new Set([
    ...base.keys(),
    ...(await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .toString()
      .split("\0")
      .filter(Boolean),
  ]);
  if (paths.size > 10000) throw new Error("Artifact exceeds 10,000 source files");
  const temporary = await mkdtemp(path.join(tmpdir(), "bugwright-artifact-"));
  const index = path.join(temporary, "index");
  const files: ArtifactFile[] = [];
  const manifest: Array<{ path: string; mode: string; sha256: string }> = [];
  const entries: string[] = [];
  let total = 0;
  try {
    await git(root, ["read-tree", "--empty"], index);
    for (const name of [...paths].sort()) {
      const safe = assertSafeRelativePath(name);
      if (safe.split("/").some((part) => part.toLowerCase() === ".git"))
        throw new Error("Git metadata cannot be source");
      const absolute = resolveInside(root, safe);
      const old = base.get(safe);
      const stat = await lstat(absolute).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) {
        if (old) files.push({ path: safe, mode: old.mode, content: null, sha256: null });
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error("Only regular, non-hardlinked source files are supported");
      if (stat.size > MAX_FILE_BYTES) throw new Error("Artifact file exceeds 8 MiB");
      const content = await readFile(absolute);
      total += content.length;
      if (content.length > MAX_FILE_BYTES || total > MAX_BYTES)
        throw new Error("Artifact exceeds size limit");
      const mode =
        process.platform === "win32" ? (old?.mode ?? "100644") : stat.mode & 0o111 ? "100755" : "100644";
      const digest = sha256(content);
      const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
      manifest.push({ path: safe, mode, sha256: digest });
      if (!old || oid !== old.oid || mode !== old.mode) {
        await git(root, ["hash-object", "-w", "--stdin"], index, content);
        files.push({ path: safe, mode, content: content.toString("base64"), sha256: digest });
      }
      entries.push(`${mode} ${oid}\t${safe}\0`);
    }
    await git(root, ["update-index", "-z", "--index-info"], index, entries.join(""));
    if (
      reproduction &&
      !manifest.some((file) => file.path === reproduction.path && file.sha256 === reproduction.sha256)
    ) {
      throw new Error("Reproduction test must be included in the source snapshot");
    }
    const tree = (await git(root, ["write-tree"], index)).toString().trim();
    const diff = (
      await git(
        root,
        ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", baseCommit, tree, "--"],
        index,
      )
    ).toString();
    const body = {
      version: 1 as const,
      baseCommit,
      tree,
      sourceHash: sha256(JSON.stringify(manifest)),
      reproduction,
      files,
      diff,
    };
    return { ...body, hash: sha256(canonical(body)) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function parseArtifact(value: unknown): ReviewArtifact {
  const artifact = value as ReviewArtifact;
  if (
    !artifact ||
    artifact.version !== 1 ||
    !Array.isArray(artifact.files) ||
    typeof artifact.hash !== "string"
  )
    throw new Error("A versioned review artifact is required; verify this task again");
  const { hash, ...body } = artifact;
  if (sha256(canonical(body)) !== hash) throw new Error("Review artifact fingerprint is invalid");
  for (const file of artifact.files) {
    assertSafeRelativePath(file.path);
    if (
      !["100644", "100755"].includes(file.mode) ||
      (file.content === null
        ? file.sha256 !== null
        : sha256(Buffer.from(file.content, "base64")) !== file.sha256)
    )
      throw new Error("Review artifact file is invalid");
  }
  return artifact;
}

export async function assertArtifactCurrent(root: string, value: unknown) {
  const artifact = parseArtifact(value);
  const current = await captureArtifact(root, artifact.baseCommit, artifact.reproduction);
  if (current.hash !== artifact.hash)
    throw new Error("Source changed; fresh verification and approval are required");
  return artifact;
}

/** Restore a managed task workspace to a previously verified artifact using
 * raw Git blobs. This deliberately leaves ignored dependency/build outputs in
 * place while replacing every source path represented by Git. */
export async function restoreArtifact(root: string, value: unknown) {
  const artifact = parseArtifact(value);
  if ((await git(root, ["rev-parse", "HEAD"])).toString().trim() !== artifact.baseCommit)
    throw new Error("Cannot restore an artifact onto a different base commit");

  const base = new Map<string, { mode: ArtifactFile["mode"]; oid: string }>();
  for (const line of (await git(root, ["ls-tree", "-rz", artifact.baseCommit]))
    .toString()
    .split("\0")
    .filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, type, oid] = line.slice(0, tab).split(" ");
    if (type !== "blob" || !["100644", "100755"].includes(mode))
      throw new Error("Symlinks and submodules are unsupported");
    base.set(assertSafeRelativePath(line.slice(tab + 1)), { mode: mode as ArtifactFile["mode"], oid });
  }
  const current = new Set([
    ...base.keys(),
    ...(await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
      .toString()
      .split("\0")
      .filter(Boolean),
  ]);
  for (const name of current) await rm(resolveInside(root, assertSafeRelativePath(name)), { force: true });

  for (const [name, entry] of base) {
    const absolute = resolveInside(root, name);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, await git(root, ["cat-file", "blob", entry.oid]));
    if (process.platform !== "win32") await chmod(absolute, entry.mode === "100755" ? 0o755 : 0o644);
  }
  for (const entry of artifact.files) {
    const absolute = resolveInside(root, entry.path);
    if (entry.content === null) {
      await rm(absolute, { force: true });
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(entry.content, "base64"));
    if (process.platform !== "win32") await chmod(absolute, entry.mode === "100755" ? 0o755 : 0o644);
  }
  return assertArtifactCurrent(root, artifact);
}

type Evidence = {
  id: string;
  artifactHash?: string | null;
  kind?: string | null;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};
export function assertReviewEvidence(artifact: ReviewArtifact, report: unknown, tests: Evidence[]) {
  const result = report as { passed?: boolean; reproductionFixed?: string; artifactHash?: string } | null;
  if (
    !artifact.reproduction ||
    result?.passed !== true ||
    result.reproductionFixed !== "passed" ||
    result.artifactHash !== artifact.hash
  )
    throw new Error("Verified reproduction evidence for this artifact is required");
  const before = tests.find((test) => test.id === artifact.reproduction!.testRunId);
  if (
    !before ||
    before.kind !== "reproduction-before" ||
    before.exitCode <= 0 ||
    before.artifactHash !== artifact.reproduction.baselineArtifactHash
  )
    throw new Error("Failing baseline evidence is missing");
  const after = tests.filter((test) => test.artifactHash === artifact.hash);
  if (!after.some((test) => test.kind === "reproduction-after" && test.exitCode === 0))
    throw new Error("Passing reproduction evidence is missing");
}

export function artifactApprovalHash(input: {
  taskId: string;
  repository: string;
  targetBranch: string;
  artifact: ReviewArtifact;
  report: unknown;
  tests: Evidence[];
}) {
  assertReviewEvidence(input.artifact, input.report, input.tests);
  const tests = input.tests
    .filter(
      (test) =>
        test.artifactHash === input.artifact.hash || test.id === input.artifact.reproduction!.testRunId,
    )
    .map(({ id, artifactHash, kind, command, exitCode, stdout, stderr, durationMs }) => ({
      id,
      artifactHash,
      kind,
      command,
      exitCode,
      stdout,
      stderr,
      durationMs,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(
    canonical({
      version: 1,
      taskId: input.taskId,
      repository: input.repository,
      targetBranch: input.targetBranch,
      artifactHash: input.artifact.hash,
      tests,
    }),
  );
}
