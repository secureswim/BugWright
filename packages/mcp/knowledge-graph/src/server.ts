import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { toolGate } from "@bugwright/policy";
import { RepositoryGraph } from "./graph.js";
import { GraphQueries } from "./query.js";

if (!process.env.BUGWRIGHT_REPO_ROOT) throw new Error("BUGWRIGHT_REPO_ROOT is required");
const graph = await new RepositoryGraph(path.resolve(process.env.BUGWRIGHT_REPO_ROOT), (message) =>
  console.error(message),
).build();
graph.watch();
const queries = new GraphQueries(graph);
const allowed = toolGate();
const server = new McpServer({ name: "bugwright-knowledge-graph", version: "0.1.0" });
const result = async (query: () => unknown) => {
  await graph.refresh();
  return { content: [{ type: "text" as const, text: JSON.stringify(query()) }] };
};
const name = z.string().min(1).max(500);
if (allowed("query_entity"))
  server.tool(
    "query_entity",
    "Look up code entities and direct relationships",
    { name, kind: z.enum(["class", "function", "variable"]).optional() },
    (input) => result(() => queries.queryEntity(input.name, input.kind)),
  );
if (allowed("find_callers"))
  server.tool("find_callers", "Find functions calling a function", { qualifiedName: name }, (input) =>
    result(() => queries.findCallers(input.qualifiedName)),
  );
if (allowed("find_callees"))
  server.tool("find_callees", "Find functions called by a function", { qualifiedName: name }, (input) =>
    result(() => queries.findCallees(input.qualifiedName)),
  );
if (allowed("find_references"))
  server.tool("find_references", "Find references across the repository", { name }, (input) =>
    result(() => queries.findReferences(input.name)),
  );
if (allowed("class_hierarchy"))
  server.tool(
    "class_hierarchy",
    "Get inheritance and implementation hierarchy",
    { className: name },
    (input) => result(() => queries.classHierarchy(input.className)),
  );
process.once("SIGINT", () => {
  graph.close();
  process.exit(0);
});
process.once("SIGTERM", () => {
  graph.close();
  process.exit(0);
});
await server.connect(new StdioServerTransport());
