import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { IGNORED_DIRECTORIES, MAX_DETECTION_DEPTH } from "./types.js";

/**
 * Directories under `root` that contain at least one of `markers`.
 *
 * Walks to {@link MAX_DETECTION_DEPTH}, which is what makes monorepos visible:
 * the previous detection looked only at the root and one level below it, so a
 * `packages/api/package.json` - the shape of most real TypeScript repositories -
 * was silently never found.
 */
export async function findProjectDirectories(root: string, markers: string[]): Promise<string[]> {
  const found: string[] = [];
  const markerSet = new Set(markers);

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DETECTION_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((entry) => entry.isFile() && markerSet.has(entry.name))) {
      const relative = path.relative(root, directory).replaceAll("\\", "/");
      found.push(relative || ".");
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
      await walk(path.join(directory, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  // Shallowest first, so the root project is preferred when nothing else matches.
  return found.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

export async function fileExists(root: string, relative: string): Promise<boolean> {
  try {
    await readdir(path.dirname(path.join(root, relative)));
    await readFile(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

export async function readIfPresent(root: string, relative: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch {
    return undefined;
  }
}
