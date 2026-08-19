/**
 * Public surface (docs/design.md). The session runtime, op catalog, and
 * `buildServer()` land under issue #2/#3; until then this exports the
 * vendored reactive core so the package is honest about what exists.
 */
export { CellGraph, CircularDependencyError, structuralEqual } from "./cell-graph.ts";
