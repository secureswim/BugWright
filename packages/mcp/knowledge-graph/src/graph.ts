import { readdir, readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import { assertSafeRelativePath, resolveInside } from "@bugwright/policy";
import type { GraphEntity, GraphRelationship, GraphRelationshipKind } from "@bugwright/shared";

type Node = Parser.SyntaxNode;
type Pending = { kind: GraphRelationshipKind; source: string; name: string; filePath: string; line: number };
type Import = { local: string; original: string; module: string };
type Parsed = { entities: GraphEntity[]; pending: Pending[]; imports: Import[]; references: Pending[] };
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
const ignored = new Set([".git", "node_modules", "dist", ".next", "coverage", "__pycache__", ".venv"]);
const classTypes = new Set([
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);
const functionTypes = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_signature",
]);
const field = (node: Node, name: string) => node.childForFieldName(name);
const nodes = function* (node: Node): Generator<Node> {
  yield node;
  for (const child of node.namedChildren) yield* nodes(child);
};

/** A cached syntax graph. Resolution is conservative: ambiguous global symbols are omitted. */
export class RepositoryGraph {
  readonly entities = new Map<string, GraphEntity>();
  relationships: GraphRelationship[] = [];
  private files = new Map<string, Parsed>();
  private dirty = new Set<string>();
  private watchers: FSWatcher[] = [];
  private parsers = new Map<string, Parser>();
  private refreshing?: Promise<void>;
  constructor(
    readonly root: string,
    private warn: (message: string) => void = console.warn,
  ) {}

  async build() {
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = resolveInside(this.root, path.relative(this.root, path.join(directory, entry.name)));
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && extensions.has(path.extname(entry.name)))
          files.push(path.relative(this.root, absolute).replaceAll("\\", "/"));
      }
    };
    await walk(this.root);
    await this.update(files);
    return this;
  }

  /** Only changed files are reparsed; edges are relinked to reflect additions/deletions. */
  async update(paths: string[]) {
    for (const filePath of new Set(paths)) {
      const safe = assertSafeRelativePath(filePath);
      if (!extensions.has(path.extname(safe))) continue;
      try {
        const source = await readFile(resolveInside(this.root, safe), "utf8");
        this.files.set(safe, this.parse(safe, source));
      } catch (error) {
        this.files.delete(safe);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          this.warn(`Knowledge graph skipped ${safe}: ${String(error)}`);
      }
    }
    this.link();
  }

  /** Internal filesystem notifications preserve the query-only MCP surface. */
  watch() {
    try {
      const watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const relative = filename.toString().replaceAll("\\", "/");
        if (relative.split("/").some((part) => ignored.has(part))) return;
        if (extensions.has(path.extname(relative))) this.dirty.add(relative);
      });
      this.watchers.push(watcher);
    } catch (error) {
      this.warn(`Knowledge graph watcher unavailable: ${String(error)}`);
    }
    return this;
  }
  close() {
    for (const watcher of this.watchers) watcher.close();
  }
  async refresh() {
    if (this.refreshing) await this.refreshing;
    if (!this.dirty.size) return;
    const changed = [...this.dirty];
    this.dirty.clear();
    this.refreshing = this.update(changed);
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private parse(filePath: string, source: string): Parsed {
    const ext = path.extname(filePath);
    let parser = this.parsers.get(ext);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(
        ext === ".py"
          ? Python
          : ext === ".ts"
            ? TypeScript.typescript
            : ext === ".tsx"
              ? TypeScript.tsx
              : JavaScript,
      );
      this.parsers.set(ext, parser);
    }
    const tree = parser.parse(source);
    try {
      if (tree.rootNode.hasError) throw new Error("Tree-sitter reported syntax errors");
      const parsed: Parsed = { entities: [], pending: [], imports: [], references: [] };
      const owners = new Map<number, GraphEntity>();
      for (const node of nodes(tree.rootNode)) {
        let kind: GraphEntity["kind"] | undefined;
        let nameNode = field(node, "name");
        if (classTypes.has(node.type)) kind = "class";
        else if (functionTypes.has(node.type)) kind = "function";
        else if (node.type === "variable_declarator") {
          const value = field(node, "value");
          if (value && ["arrow_function", "function_expression"].includes(value.type)) kind = "function";
          else if (!this.owner(node, owners, "function")) kind = "variable";
        } else if (
          ext === ".py" &&
          node.type === "assignment" &&
          !this.owner(node, owners, "function") &&
          !this.owner(node, owners, "class")
        ) {
          nameNode = field(node, "left");
          kind = "variable";
        } else if (["public_field_definition", "property_signature"].includes(node.type)) kind = "variable";
        if (
          !kind ||
          !nameNode ||
          !["identifier", "property_identifier", "type_identifier"].includes(nameNode.type)
        )
          continue;
        const parent = this.owner(node, owners);
        const qualifiedName = parent ? `${parent.qualifiedName}.${nameNode.text}` : nameNode.text;
        const entity: GraphEntity = {
          id: `${filePath}::${qualifiedName}:${node.startPosition.row + 1}`,
          kind,
          name: nameNode.text,
          qualifiedName,
          filePath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: node.text.split(/\r?\n/)[0].slice(0, 500),
        };
        const previous = node.previousNamedSibling;
        if (previous?.type === "comment") entity.documentation = previous.text.slice(0, 2000);
        const body = field(node, "body");
        if (
          ext === ".py" &&
          body?.firstNamedChild?.type === "expression_statement" &&
          body.firstNamedChild.firstNamedChild?.type === "string"
        )
          entity.documentation = body.firstNamedChild.text.slice(0, 2000);
        parsed.entities.push(entity);
        owners.set(node.id, entity);
        parsed.pending.push({
          kind: "defines",
          source: filePath,
          name: entity.id,
          filePath,
          line: entity.startLine,
        });
        if (parent?.kind === "class")
          parsed.pending.push({
            kind: "contains",
            source: parent.id,
            name: entity.id,
            filePath,
            line: entity.startLine,
          });
        if (kind === "class") {
          for (const child of node.namedChildren) {
            const relation =
              child.type === "class_heritage"
                ? undefined
                : child.type === "extends_type_clause"
                  ? "inherits"
                  : child.type === "implements_clause"
                    ? "implements"
                    : child.type === "argument_list" && ext === ".py"
                      ? "inherits"
                      : undefined;
            if (relation)
              for (const target of child.namedChildren)
                parsed.pending.push({
                  kind: relation,
                  source: entity.id,
                  name: target.text,
                  filePath,
                  line: target.startPosition.row + 1,
                });
            if (child.type === "class_heritage")
              for (const clause of child.namedChildren)
                for (const target of clause.namedChildren)
                  parsed.pending.push({
                    kind: clause.type === "implements_clause" ? "implements" : "inherits",
                    source: entity.id,
                    name: target.text,
                    filePath,
                    line: target.startPosition.row + 1,
                  });
          }
        }
      }
      for (const node of nodes(tree.rootNode)) {
        if (node.type === "import_statement") {
          const module = field(node, "source")?.text.slice(1, -1);
          if (module)
            for (const child of nodes(node)) {
              if (child.type === "import_specifier")
                parsed.imports.push({
                  local: (field(child, "alias") ?? field(child, "name"))!.text,
                  original: field(child, "name")!.text,
                  module,
                });
              else if (child.type === "import_clause" && child.firstNamedChild?.type === "identifier")
                parsed.imports.push({ local: child.firstNamedChild.text, original: "default", module });
              else if (child.type === "namespace_import")
                parsed.imports.push({ local: child.lastNamedChild!.text, original: "*", module });
            }
          if (ext === ".py")
            for (const child of node.namedChildren) {
              if (child.type === "dotted_name")
                parsed.imports.push({ local: child.text, original: "*", module: child.text });
              if (child.type === "aliased_import")
                parsed.imports.push({
                  local: field(child, "alias")!.text,
                  original: "*",
                  module: field(child, "name")!.text,
                });
            }
        }
        if (node.type === "import_from_statement") {
          const module = field(node, "module_name")?.text;
          if (module)
            for (const child of node.namedChildren) {
              if (child.id === field(node, "module_name")?.id) continue;
              if (child.type === "dotted_name")
                parsed.imports.push({ local: child.text, original: child.text, module });
              if (child.type === "aliased_import")
                parsed.imports.push({
                  local: field(child, "alias")!.text,
                  original: field(child, "name")!.text,
                  module,
                });
            }
        }
        const owner = this.owner(node, owners, "function");
        if (owner && ["call_expression", "call"].includes(node.type)) {
          const target = field(node, "function");
          if (target) {
            let name = target.text;
            if (/^(this|self)\./.test(name))
              name = `${this.owner(node, owners, "class")?.qualifiedName ?? ""}.${name.split(".").slice(1).join(".")}`;
            parsed.pending.push({
              kind: "calls",
              source: owner.id,
              name,
              filePath,
              line: node.startPosition.row + 1,
            });
          }
        }
        if (
          ["identifier", "type_identifier"].includes(node.type) &&
          node.parent &&
          field(node.parent, "name")?.id !== node.id
        )
          parsed.references.push({
            kind: "references",
            source: owner?.id ?? filePath,
            name: node.text,
            filePath,
            line: node.startPosition.row + 1,
          });
      }
      return parsed;
    } finally {
      /* Native syntax trees are released by the Node binding. */
    }
  }

  private owner(node: Node, owners: Map<number, GraphEntity>, kind?: GraphEntity["kind"]) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const entity = owners.get(parent.id);
      if (entity && (!kind || entity.kind === kind)) return entity;
    }
    return undefined;
  }

  private modulePath(file: string, module: string) {
    let base: string;
    if (module.startsWith(".")) {
      if (file.endsWith(".py")) {
        const dots = module.match(/^\.+/)![0].length;
        base = path.posix.join(
          path.posix.dirname(file),
          ...Array.from({ length: dots - 1 }, () => ".."),
          module.slice(dots).replaceAll(".", "/"),
        );
      } else base = path.posix.join(path.posix.dirname(file), module);
    } else if (file.endsWith(".py")) base = module.replaceAll(".", "/");
    else return undefined;
    const candidates = [
      base,
      base.replace(/\.js$/, ".ts"),
      ...[...extensions].map((ext) => base + ext),
      ...[...extensions].map((ext) => `${base}/index${ext}`),
      `${base}/__init__.py`,
    ];
    return candidates.find((candidate) => this.files.has(candidate));
  }

  private link() {
    this.entities.clear();
    this.relationships = [];
    const byName = new Map<string, GraphEntity[]>();
    const byFile = new Map<string, GraphEntity[]>();
    for (const parsed of this.files.values())
      for (const entity of parsed.entities) {
        this.entities.set(entity.id, entity);
        const fileEntities = byFile.get(entity.filePath) ?? [];
        fileEntities.push(entity);
        byFile.set(entity.filePath, fileEntities);
        for (const name of new Set([entity.name, entity.qualifiedName]))
          byName.set(name, [...(byName.get(name) ?? []), entity]);
      }
    const resolve = (name: string, filePath: string): GraphEntity | undefined => {
      if (this.entities.has(name)) return this.entities.get(name);
      const parsed = this.files.get(filePath)!;
      const [first, ...rest] = name.split(".");
      const imported = parsed.imports.find((item) => item.local === first);
      if (imported) {
        const targetFile = this.modulePath(filePath, imported.module);
        const targetName =
          imported.original === "*" ? rest.join(".") : [imported.original, ...rest].join(".");
        const matches = (targetFile ? (byFile.get(targetFile) ?? []) : []).filter(
          (entity) => entity.qualifiedName === targetName,
        );
        if (matches.length === 1) return matches[0];
      }
      const candidates = byName.get(name) ?? [];
      const local = candidates.filter((entity) => entity.filePath === filePath);
      if (local.length === 1) return local[0];
      return undefined;
    };
    const edgeKeys = new Set<string>();
    const add = (pending: Pending, target: GraphEntity) => {
      const edge: GraphRelationship = {
        kind: pending.kind,
        source: pending.source,
        target: target.id,
        filePath: pending.filePath,
        line: pending.line,
      };
      const key = JSON.stringify(edge);
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        this.relationships.push(edge);
      }
    };
    for (const [filePath, parsed] of this.files) {
      for (const imported of parsed.imports) {
        const target = resolve(imported.local, filePath);
        if (target)
          add({ kind: "imports", source: filePath, name: imported.local, filePath, line: 1 }, target);
      }
      for (const pending of parsed.pending) {
        const target = resolve(pending.name, filePath);
        if (target) add(pending, target);
      }
      for (const pending of parsed.references) {
        const target = resolve(pending.name, filePath);
        if (target) add(pending, target);
      }
    }
  }
}
