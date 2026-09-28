import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { SWEBenchInstance } from "@bugwright/shared";
export type { SWEBenchInstance } from "@bugwright/shared";

export function parseTestIds(value: string): string[] {
  return z.array(z.string().min(1)).parse(JSON.parse(value));
}
const tests = z.string().superRefine((value, context) => {
  try {
    parseTestIds(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a JSON array of test IDs" });
  }
});
const schema = z.object({
  instance_id: z.string().regex(/^[\w.-]+__[\w.-]+-\d+$/),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  base_commit: z.string().regex(/^[a-f0-9]{40}$/i),
  problem_statement: z.string().min(1),
  hints_text: z.string().default(""),
  test_patch: z.string(),
  patch: z.string(),
  version: z.string(),
  FAIL_TO_PASS: tests,
  PASS_TO_PASS: tests,
  environment_setup_commit: z.string().default(""),
});
export const parseInstance = (value: unknown): SWEBenchInstance => schema.parse(value);
export interface InstanceFilter {
  repo?: string;
  instanceId?: string;
  instanceIds?: string[];
}
export async function loadInstances(file: string, filter: InstanceFilter = {}): Promise<SWEBenchInstance[]> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const instances: SWEBenchInstance[] = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let instance: SWEBenchInstance;
      try {
        instance = parseInstance(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid dataset line ${lineNumber}: ${String(error)}`);
      }
      if (seen.has(instance.instance_id)) throw new Error(`Duplicate instance ${instance.instance_id}`);
      seen.add(instance.instance_id);
      if (filter.repo && instance.repo !== filter.repo) continue;
      if (filter.instanceId && instance.instance_id !== filter.instanceId) continue;
      if (filter.instanceIds && !filter.instanceIds.includes(instance.instance_id)) continue;
      instances.push(instance);
    }
  } finally {
    lines.close();
  }
  return instances;
}
