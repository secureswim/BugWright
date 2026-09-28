# Repository knowledge graph

This MCP server parses TypeScript, TSX, JavaScript, JSX and Python into a cached
Tree-sitter syntax graph. Only the five query tools are registered, subject to
BugWright's role tool gate. Source metadata is untrusted repository content.

The internal filesystem watcher queues changed source paths. Before each query,
only those files are reparsed and all edges are relinked, removing deleted or
invalid entities. Dependencies, Git internals, generated output and symlinks are
excluded. Syntax errors produce a warning on stderr and skip that file.

Relationships are static approximations, not runtime guarantees. Local symbols,
relative JavaScript/TypeScript imports, Python module imports and import aliases
are resolved conservatively. Dynamic dispatch, external dependencies, package
aliases, re-exports and ambiguous overloaded symbols can remain unresolved;
researchers should confirm relevant findings with source reads. Filesystem
watching requires recursive watch support in the host Node runtime; if the
watcher cannot start, the server warns and retains its startup snapshot.
