/**
 * Session presets (docs/design.md §2): a preset is DATA -- seed input
 * cells plus canned define-specs over the same op catalog agents use
 * directly via `session_define`. No privileged code path; `graph-theory`
 * exists to show the pattern (and to give the spike's parse → analyze →
 * BFS pipeline a one-call home).
 */
import type { DefineSpec } from "./ops.ts";

export type SessionKind = "generic" | "graph-theory";

export interface Preset {
  seed: Record<string, unknown>;
  defines: DefineSpec[];
}

export const PRESETS: Record<SessionKind, Preset> = {
  generic: { seed: {}, defines: [] },
  "graph-theory": {
    seed: {
      edgeListText: "A B 4\nA C 2\nC B 1\nB D 5",
      directed: false,
      startVertex: "A",
    },
    defines: [
      { cell: "parsed", op: "graph_parse_edge_list", args: { text: { $cell: "edgeListText" }, directed: { $cell: "directed" } } },
      { cell: "analysis", op: "graph_analyze", args: { graph: { $cell: "parsed" } } },
      { cell: "bfsOrder", op: "graph_bfs", args: { graph: { $cell: "parsed" }, start: { $cell: "startVertex" } } },
    ],
  },
};
