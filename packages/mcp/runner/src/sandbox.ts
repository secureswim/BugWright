import { CommandSpec } from "@bugwright/adapters";

/**
 * Opt-in fully read-only workspace.
 *
 * It was the default until it turned out to break most real JavaScript
 * projects: Vite bundles a TypeScript config to a temp file *next to the
 * config* before importing it, so `vitest.config.ts` makes vitest die at
 * startup with EACCES on a read-only mount. Jest with a `.ts` config, and any
 * tool that writes beside its own config, behave the same way.
 *
 * What the mount was protecting against - a hostile test suite rewriting the
 * source under review so the approved diff is not the tested diff - is now
 * caught after the fact instead: `.git` stays read-only so history cannot be
 * rewritten, and the orchestrator compares the diff before and after testing
 * and stops if the workspace changed. Detection with evidence rather than
 * prevention that does not work. See docs/threat-model.md.
 */
const FORCE_READ_ONLY = process.env.BUGWRIGHT_RUNNER_READONLY === "1";

/** Builds the container argv. Pure, so the sandbox flags can be unit-tested. */
export function buildRunArgs(input: {
  image: string;
  root: string;
  workdir: string;
  command: CommandSpec;
  mounts: Array<{ volume: string; containerPath: string }>;
  readOnly: boolean;
}): string[] {
  const workspaceReadOnly = input.readOnly && FORCE_READ_ONLY;
  return [
    "run",
    "--rm",
    "--network",
    input.command.network,
    "--cpus",
    "2",
    "--memory",
    "2g",
    "--pids-limit",
    "256",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "-v",
    `${input.root}:/workspace${workspaceReadOnly ? ":ro" : ""}`,
    // Always read-only, whatever the workspace mode: the diff a human approves
    // is computed from this history, so nothing the repository runs may edit it.
    "-v",
    `${input.root}/.git:/workspace/.git:ro`,
    "--tmpfs",
    "/tmp:rw,nosuid,size=256m",
    ...input.mounts.flatMap((mount) => ["-v", `${mount.volume}:${mount.containerPath}`]),
    "-w",
    input.workdir,
    input.image,
    ...input.command.argv,
  ];
}
