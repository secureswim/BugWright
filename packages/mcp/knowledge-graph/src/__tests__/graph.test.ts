import { mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryGraph } from "../graph.js";
import { GraphQueries } from "../query.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "bugwright-graph-"));
  directories.push(directory);
  await cp(fileURLToPath(new URL("./fixtures", import.meta.url)), directory, { recursive: true });
  const graph = await new RepositoryGraph(directory).build();
  return { directory, graph, query: new GraphQueries(graph) };
}
describe("repository knowledge graph", () => {
  it("extracts entities, imports, calls, references and class hierarchy", async () => {
    const { query } = await fixture();
    expect(query.queryEntity("Child", "class")[0].filePath).toBe("child.ts");
    expect(query.queryEntity("Child.run")[0].signature).toContain("run()");
    expect(
      query
        .findCallers("helper")
        .map((item) => item.entity.qualifiedName)
        .sort(),
    ).toEqual(["Child.run", "caller"]);
    expect(query.findCallees("Child.again")[0].entity.qualifiedName).toBe("Child.run");
    expect(query.findReferences("LIMIT").some((item) => item.filePath === "base.ts")).toBe(true);
    const hierarchy = query.classHierarchy("Child")[0];
    expect(hierarchy.superclasses.map((item) => item.name)).toEqual(["Base"]);
    expect(hierarchy.interfaces.map((item) => item.name)).toEqual(["Contract"]);
    expect(query.classHierarchy("Base")[0].subclasses.map((item) => item.name)).toEqual(["Child"]);
    expect(query.queryEntity("helper")[0].relationships.some((item) => item.kind === "imports")).toBe(true);
  });
  it("skips invalid files while preserving valid graph data", async () => {
    const { directory, graph, query } = await fixture();
    await writeFile(path.join(directory, "broken.ts"), "class {");
    await graph.update(["broken.ts"]);
    expect(query.queryEntity("Child")).toHaveLength(1);
    expect([...graph.entities.values()].some((entity) => entity.filePath === "broken.ts")).toBe(false);
  });
  it("replaces changed entities and removes stale edges after changes and deletions", async () => {
    const { directory, graph, query } = await fixture();
    await writeFile(path.join(directory, "child.ts"), "export function replacement() { return 1; }");
    await graph.update(["child.ts"]);
    expect(query.queryEntity("Child")).toEqual([]);
    expect(query.findCallers("helper")).toEqual([]);
    expect(query.queryEntity("replacement")).toHaveLength(1);
    await rm(path.join(directory, "child.ts"));
    await graph.update(["child.ts"]);
    expect(query.queryEntity("replacement")).toEqual([]);
  });
  it("supports JavaScript and Python syntax and import aliases", async () => {
    const { directory, graph, query } = await fixture();
    await writeFile(
      path.join(directory, "utility.py"),
      "VALUE = 1\ndef helper():\n    return VALUE\nclass Parent:\n    pass\n",
    );
    await writeFile(
      path.join(directory, "consumer.py"),
      "from utility import helper as compute, Parent\nimport utility as util\nclass Sub(Parent):\n    def run(self):\n        return compute()\ndef namespace_call():\n    return util.helper()\n",
    );
    await writeFile(
      path.join(directory, "script.js"),
      "import * as base from './base.js'; export const work = () => 1; export function invoke() { return work(); } export function namespaceCall() { return base.helper(); }",
    );
    await graph.update(["utility.py", "consumer.py", "script.js"]);
    expect(query.findCallees("Sub.run")[0].entity.filePath).toBe("utility.py");
    expect(query.classHierarchy("Sub")[0].superclasses[0].name).toBe("Parent");
    expect(query.findCallees("invoke")[0].entity.name).toBe("work");
    expect(query.findCallees("namespace_call")[0].entity.filePath).toBe("utility.py");
    expect(query.findCallees("namespaceCall")[0].entity.filePath).toBe("base.ts");
  });
  it("rejects paths outside the repository", async () => {
    const { graph } = await fixture();
    await expect(graph.update(["../outside.ts"])).rejects.toThrow();
  });
});
