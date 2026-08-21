/**
 * The op catalog + define-spec model (docs/design.md §5): `graph.define()`
 * takes a JS closure, which can't cross an MCP boundary, so computed cells
 * are declared as plain-JSON **define-specs** naming an op from this
 * server-side catalog. `{ "$cell": "name" }` arguments are live references
 * resolved at compute time via `graph.get`, so reactivity (recompute when
 * an upstream cell is `set`) comes from `CellGraph` itself, unchanged.
 *
 * No expression eval, no code injection surface: the entire compute
 * surface is this catalog -- each op a named, typed, tested function.
 * (`math_eval` accepts a mallory-math Symbolic expression string, but
 * that's `Symbolic.parse` over a closed math grammar with an explicit
 * variable env -- structured input, not code.)
 */
import { Graph, Symbolic } from "mallory-math";

/** A live reference to another cell inside a define-spec's args. */
export interface CellRef {
  $cell: string;
}

export function isCellRef(value: unknown): value is CellRef {
  return typeof value === "object" && value !== null && "$cell" in value && typeof (value as CellRef).$cell === "string";
}

/**
 * Every `$cell` reference found anywhere in a define-spec's `args`
 * (recursively through nested objects/arrays) -- a cell's own immediate
 * dependency set (issue #5's provenance/audit trail).
 *
 * Provably complete for this catalog, not just a best-effort scan:
 * `resolveArg` (session.ts) is the ONLY place `$cell` references are ever
 * consumed, and it walks `args` in exactly this same shape (literal JSON,
 * no dynamic/conditional structure) before handing already-resolved plain
 * values to `catalogEntry.fn` -- an op function never sees a `$cell`
 * marker or calls back into the graph itself, so it can't introduce a
 * dependency this walk would miss. That's what makes reading this
 * statically off the stored `DefineSpec` (session.ts's own `defines` map)
 * exactly equivalent to querying `CellGraph`'s own live dependency
 * tracking, without needing to expose any new API on the vendored
 * `cell-graph.ts`.
 */
export function extractCellRefs(args: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const walk = (value: unknown): void => {
    if (isCellRef(value)) {
      refs.add(value.$cell);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(args);
  return [...refs];
}

/** The JSON shape `session_define` accepts (docs/design.md §5). */
export interface DefineSpec {
  cell: string;
  op: string;
  args: Record<string, unknown>;
}

/** Args after `$cell` references have been swapped for the referenced cells' current values. */
export type ResolvedArgs = Record<string, unknown>;

export type OpFn = (args: ResolvedArgs) => unknown;

/**
 * A catalog entry's optional declared capability requirement (issue #7):
 * when set, `session_define` rejects using this op unless the session was
 * opened with this capability granted (`session_open`'s own `capabilities`
 * arg) -- checked statically against this field before the op ever runs,
 * not left to the op's own `fn` to self-police. Generalizes this repo's
 * existing single global env-var write gate (README's "Write-path auth
 * precedent") into an explicit, per-op, per-session one; see
 * `SessionTable`'s own doc comment on `applyDefine` for the enforcement
 * side. No entry in the shipped `OP_CATALOG` below declares one yet --
 * every current op is pure/read-only -- this is the mechanism a future
 * effectful op would opt into, built ahead of having one per the issue's
 * own "natural next step on the existing pattern" framing.
 */
export interface OpCatalogEntry {
  fn: OpFn;
  description: string;
  requiresCapability?: string;
}

export type OpCatalog = Record<string, OpCatalogEntry>;

function asString(args: ResolvedArgs, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw new Error(`op arg "${name}" must be a string, got ${typeof v}`);
  return v;
}

function asBoolean(args: ResolvedArgs, name: string, fallback: boolean): boolean {
  const v = args[name];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`op arg "${name}" must be a boolean, got ${typeof v}`);
  return v;
}

function asGraph(args: ResolvedArgs, name: string): Graph<string> {
  const v = args[name];
  if (!(v instanceof Graph)) throw new Error(`op arg "${name}" must be a graph cell (the value of a graph_parse_edge_list cell), got ${typeof v}`);
  return v as Graph<string>;
}

/**
 * Grapher's own small edge-list parser -- the same line format
 * mallory-graph's GraphTheoryPanel uses (`from to [weight]`, one edge per
 * line; a single token declares an isolated vertex; weight defaults to
 * 1), reimplemented against mallory-math's `Graph` directly per
 * docs/design.md §10 (contract parity with the panel, not byte parity --
 * no mallory-graph dependency).
 */
export function parseEdgeListText(text: string, directed: boolean): Graph<string> {
  const graph = new Graph<string>(directed);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("edge list is empty -- one `from to [weight]` edge (or a lone vertex name) per line");
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    if (tokens.length === 1) {
      graph.addVertex(tokens[0]!);
      continue;
    }
    if (tokens.length > 3) throw new Error(`bad edge line "${line}" -- expected \`from to [weight]\``);
    const weight = tokens.length === 3 ? Number(tokens[2]) : 1;
    if (!Number.isFinite(weight)) throw new Error(`bad weight in edge line "${line}"`);
    graph.addEdge(tokens[0]!, tokens[1]!, weight);
  }
  return graph;
}

/**
 * The v1 catalog (docs/design.md §5). Growable; every entry documents its
 * args and value shape in `description` so the MCP surface can list them
 * verbatim (a future `catalog_list` tool needs no second source of truth).
 */
export const OP_CATALOG: OpCatalog = {
  math_eval: {
    description:
      'Evaluate a mallory-math Symbolic expression string over named numeric variables. args: { expr: string, vars?: { name: number | {"$cell": ...} } }. value: number.',
    fn: (args) => {
      const expr = asString(args, "expr");
      const varsRaw = args.vars ?? {};
      if (typeof varsRaw !== "object" || varsRaw === null || Array.isArray(varsRaw)) throw new Error('op arg "vars" must be an object of name -> number');
      const env: Record<string, number> = {};
      for (const [name, value] of Object.entries(varsRaw)) {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`math_eval var "${name}" must resolve to a finite number, got ${typeof value}`);
        env[name] = value;
      }
      return Symbolic.evaluate(Symbolic.parse(expr), env);
    },
  },
  graph_parse_edge_list: {
    description: 'Parse a `from to [weight]`-per-line edge list into a graph value. args: { text: string, directed?: boolean (default true) }. value: graph (opaque; project with session_get_cell).',
    fn: (args) => parseEdgeListText(asString(args, "text"), asBoolean(args, "directed", true)),
  },
  graph_analyze: {
    description:
      "Structural analysis of a graph cell. args: { graph: graph }. value: { hasCycle, connectedComponents, stronglyConnectedComponents, topologicalOrder, adjacencyMatrix: { matrix, order } }.",
    fn: (args) => {
      const graph = asGraph(args, "graph");
      return {
        hasCycle: graph.hasCycle(),
        connectedComponents: graph.connectedComponents(),
        stronglyConnectedComponents: graph.stronglyConnectedComponents(),
        topologicalOrder: graph.topologicalSort(),
        adjacencyMatrix: graph.toAdjacencyMatrix(),
      };
    },
  },
  graph_bfs: {
    description: "Breadth-first traversal order. args: { graph: graph, start: string }. value: string[].",
    fn: (args) => asGraph(args, "graph").bfs(asString(args, "start")),
  },
  graph_dfs: {
    description: "Depth-first traversal order. args: { graph: graph, start: string }. value: string[].",
    fn: (args) => asGraph(args, "graph").dfs(asString(args, "start")),
  },
  graph_dijkstra: {
    description: "Dijkstra shortest-path distances from a start vertex. args: { graph: graph, start: string }. value: [{ vertex, distance }].",
    fn: (args) => {
      const distances = asGraph(args, "graph").dijkstra(asString(args, "start"));
      return [...distances.entries()].map(([vertex, distance]) => ({ vertex, distance }));
    },
  },
};

/**
 * A cell value projected to JSON for `session_get_cell` (docs/design.md
 * §5): rich catalog-internal values (a `Graph` instance) flow between
 * cells as-is, but cross the MCP boundary as a typed projection rather
 * than throwing or serializing to `{}`.
 */
export function projectValue(value: unknown): unknown {
  if (value instanceof Graph) {
    return { $type: "graph", directed: value.directed, vertices: value.vertices(), edges: value.edges() };
  }
  if (value instanceof Map) {
    return { $type: "map", entries: [...value.entries()] };
  }
  return value;
}
