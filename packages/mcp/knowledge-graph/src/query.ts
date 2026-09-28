import type { GraphEntity } from "@bugwright/shared";
import { RepositoryGraph } from "./graph.js";

export class GraphQueries {
  constructor(readonly graph: RepositoryGraph) {}
  queryEntity(name: string, kind?: GraphEntity["kind"]) {
    return [...this.graph.entities.values()]
      .filter(
        (entity) =>
          (entity.name === name || entity.qualifiedName === name || entity.id === name) &&
          (!kind || entity.kind === kind),
      )
      .map((entity) => ({
        ...entity,
        relationships: this.graph.relationships.filter(
          (edge) => edge.source === entity.id || edge.target === entity.id,
        ),
      }));
  }
  private calls(name: string, direction: "source" | "target") {
    const opposite = direction === "source" ? "target" : "source";
    const ids = new Set(this.queryEntity(name, "function").map((entity) => entity.id));
    return this.graph.relationships
      .filter((edge) => edge.kind === "calls" && ids.has(edge[direction]))
      .map((edge) => ({
        entity: this.graph.entities.get(edge[opposite])!,
        filePath: edge.filePath,
        line: edge.line,
      }));
  }
  findCallers(qualifiedName: string) {
    return this.calls(qualifiedName, "target");
  }
  findCallees(qualifiedName: string) {
    return this.calls(qualifiedName, "source");
  }
  findReferences(name: string) {
    const ids = new Set(this.queryEntity(name).map((entity) => entity.id));
    return this.graph.relationships.filter(
      (edge) =>
        ids.has(edge.target) &&
        ["references", "imports", "calls", "inherits", "implements"].includes(edge.kind),
    );
  }
  classHierarchy(className: string) {
    return this.queryEntity(className, "class").map((entity) => {
      const traverse = (kind: "inherits" | "implements", reverse: boolean) => {
        const found = new Set<string>();
        const queue = [entity.id];
        while (queue.length) {
          const current = queue.shift()!;
          for (const edge of this.graph.relationships) {
            if (edge.kind !== kind || (reverse ? edge.target : edge.source) !== current) continue;
            const next = reverse ? edge.source : edge.target;
            if (next === entity.id || found.has(next)) continue;
            found.add(next);
            queue.push(next);
          }
        }
        return [...found].map((id) => this.graph.entities.get(id)!);
      };
      return {
        entity,
        superclasses: traverse("inherits", false),
        interfaces: traverse("implements", false),
        subclasses: traverse("inherits", true),
        implementors: traverse("implements", true),
      };
    });
  }
}
