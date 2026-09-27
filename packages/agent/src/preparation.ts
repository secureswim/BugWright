/** Benchmark inputs may pin an immutable commit instead of a moving branch. */
export function pinnedCommit(baseCommit: string | null | undefined): string | undefined {
  if (!baseCommit) return undefined;
  if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error("Pinned base commit must be a full Git SHA");
  return baseCommit.toLowerCase();
}

export function cloneArguments(
  repositoryUrl: string,
  baseBranch: string,
  repoRoot: string,
  baseCommit?: string | null,
): string[] {
  const pinned = pinnedCommit(baseCommit);
  return [
    "-c",
    "core.autocrlf=false",
    "clone",
    "--depth",
    "1",
    ...(pinned ? [] : ["--branch", baseBranch]),
    "--",
    repositoryUrl,
    repoRoot,
  ];
}
