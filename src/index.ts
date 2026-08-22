/**
 * Public surface (docs/design.md): the transport-agnostic `buildServer`
 * (§7), the session runtime it serves (§1-§3), the op catalog + define-
 * spec model (§5), the resource guards (§9), and the reactive core
 * underneath it all (§6 -- now in @johnhenry/math).
 */
export { CellGraph, CircularDependencyError, structuralEqual } from "@johnhenry/math";
export { DEFAULT_LIMITS, limitsFromEnv, type SessionLimits } from "./limits.ts";
export { OP_CATALOG, parseEdgeListText, projectValue, isCellRef, type CellRef, type DefineSpec } from "./ops.ts";
export { PRESETS, type Preset, type SessionKind } from "./presets.ts";
export { SessionError, SessionTable, type SessionInfo } from "./session.ts";
export { buildServer } from "./server.ts";
