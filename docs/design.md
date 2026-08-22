# math-grapher v1 design

Settles the open questions in [#1](https://github.com/johnhenry/mallory-grapher/issues/1).
Decided collaboratively 2026-08-19; each section notes the decision, the
alternatives considered, and why.

## 1. Session lifetime: in-memory, ephemeral

Sessions live in the server process's memory and die with it. No
persistence, no resumability in v1.

- Matches the semantics the in-page WebMCP tools already have — a browser
  tab's `CellGraph` dies with the tab; "same contract, just remote" keeps
  that property rather than quietly promising more.
- Persistence forces serialization questions v1 shouldn't answer yet
  (computed cells can't serialize — only inputs and define-specs can).
  The op-catalog decision (§5) actually makes a future `session_save`
  cheap — a session's full state IS its input cells + define specs, both
  plain JSON — but that's a v2 feature, deliberately not in scope.

Rejected: persisted/resumable (premature), snapshot-on-demand (same,
though the door stays open).

## 2. API shape: generic cell core + one preset

The runtime is a pure `CellGraph` host with a generic cell API
(open/set/get/list/define/close — see §7). On top of that, `session_open`
accepts a `kind`:

- `"generic"` — an empty graph; the agent builds everything with
  `session_set_cell` and `session_define`.
- `"graph-theory"` — pre-wires the parse → analyze → BFS chain the
  feasibility spike (mallory's `cell-graph-headless-spike.test.ts`)
  already proved headless-viable, expressed as canned §5 define-specs
  over the same op catalog agents use directly. A preset is *data*, not
  privileged code — it shows the pattern without a second code path.

## 3. Concurrency: serialized per session

Calls against one session queue and execute one at a time; distinct
sessions are fully independent. `CellGraph` is single-threaded reactive
code with no locking — serializing per-session preserves that with zero
new machinery. Fully-concurrent same-session access is explicitly out of
scope (it would require making notify/recompute re-entrant).

## 4. Write gating: the server is the opt-in

No per-tool env gates. A running math-grapher server IS the opt-in —
it only exists when explicitly launched (stdio: the host spawned it;
HTTP: the operator started it). This differs deliberately from
mallory's `gallery_save` precedent (`MALLORY_GRAPH_ENABLE_MCP_WRITE`),
which gates one write tool inside an otherwise-read-only server that's
always mounted; here the whole server is write-capable by nature, so the
gate at tool granularity would be theater. **If** mallory later
mounts grapher inside its own always-on `/api/mcp`
([#4](https://github.com/johnhenry/mallory-grapher/issues/4)), THAT
integration must add an env gate at the mount point — recorded there,
not here.

## 5. Computed cells: define-specs over an op catalog

`graph.define()` takes a JS closure, which can't cross an MCP boundary.
Instead, `session_define` accepts a **define-spec**: plain JSON naming an
op from a server-side catalog plus cell references for its inputs:

```json
{
  "cell": "analysis",
  "op": "graph_analyze",
  "args": { "graph": { "$cell": "parsed" } }
}
```

- Cells hold arbitrary JSON values (plus catalog-internal rich values —
  see below).
- `{ "$cell": "name" }` marks an argument as a live reference; the
  runtime translates the spec into a real `graph.define(cell, () => op(...
  graph.get(ref)...))`, so reactivity (recompute on upstream `set`) comes
  from `CellGraph` itself, unchanged.
- No expression strings, no parsing, no eval — the entire compute surface
  is the catalog, each op a named, typed, tested function. Same
  "structured inputs only, no arbitrary code execution" stance
  mallory-mcp already advertises.

**v1 op catalog** (small, honest, growable):

| op | args | value |
|---|---|---|
| `math_eval` | `expr` (Symbolic string), `vars` (map of cell refs/numbers) | number — mallory-mcp's `symbolic_evaluate` precedent, scoped to named vars |
| `graph_parse_edge_list` | `text`, `directed` | Graph |
| `graph_analyze` | `graph` | `{ hasCycle, components, sccs, topologicalOrder, adjacencyMatrix }` |
| `graph_bfs` / `graph_dfs` | `graph`, `start` | traversal order |
| `graph_dijkstra` | `graph`, `start` | distances |

Non-JSON intermediate values (a `Graph` instance) may flow **between**
cells inside a session; `session_get_cell` serializes them to a JSON
projection (or returns a typed "opaque value" marker with a summary)
rather than throwing. Exact projections are per-op documentation.

The `graph-theory` preset (§2) is precisely: three canned define-specs
(`graph_parse_edge_list` → `graph_analyze` → `graph_bfs`) plus seed input
cells (`edgeListText`, `directed`, `startVertex`).

Rejected: presets-only (no composability — the whole point of a live
session over `gallery_get` is building pipelines); free-form Symbolic
expression cells as the *primary* mechanism (subsumed — `math_eval` IS
that, as one catalog op instead of a special case).

## 6. CellGraph source: promoted to @johnhenry/math

- **v1**: vendored mallory's `cell-graph.ts` (+ its test) into this repo.
  The file had zero imports — a clean lift. The vendored copy was frozen
  except for grapher's own needs; drift from mallory's copy was accepted
  during the interim.
- **Done**: `CellGraph` has moved to **@johnhenry/math** (tracked as
  johnhenry/math#56), and BOTH mallory and math-grapher import it from
  there. This repo's local vendored copy (`src/cell-graph.ts` and its
  test) has been deleted; the swap was mechanical.

Rejected (at the time): blocking v1 on the @johnhenry/math release
(slowest path); importing from mallory (an app, not a library — exactly
the coupling this repo exists to avoid).

## 7. Transport: both from day one

`buildServer()` is transport-agnostic (mallory-mcp's own pattern). Two
entries ship in v1:

- **stdio CLI** (`math-grapher` bin) — the primary path; an agent host
  spawns it, sessions live exactly as long as the process.
- **HTTP** (`WebStandardStreamableHTTPServerTransport`) — one process, one
  in-memory session table; the transport carries the MCP session, and our
  `sessionId`s ride inside tool args (§8), so no extra session-affinity
  plumbing is needed. This is also the path
  [#4](https://github.com/johnhenry/mallory-grapher/issues/4)'s optional
  mallory mount would reuse.

## 8. Tool surface

| tool | args | returns |
|---|---|---|
| `session_open` | `kind: "generic" \| "graph-theory"`, optional `seed: {cell: value}` | `{ sessionId }` |
| `session_close` | `sessionId` | `{ closed: true }` |
| `session_list` | — | `[{ sessionId, kind, cellCount, createdAt }]` |
| `session_set_cell` | `sessionId`, `cell`, `value` (JSON) | `{ ok }` |
| `session_get_cell` | `sessionId`, `cell` | `{ value }` (JSON projection, §5) |
| `session_list_cells` | `sessionId` | `[{ cell, role: "free" \| "computed", op? }]` |
| `session_define` | `sessionId`, define-spec (§5) | `{ ok }` |

Naming mirrors the in-page WebMCP trio (`list_cells`/`get_cell`/
`set_cell`) with a `session_` prefix so the tools coexist unambiguously
next to other servers' tools.

## 9. Resource guards: configurable via env, sane defaults

| limit | default | env |
|---|---|---|
| concurrent sessions | 16 | `MATH_GRAPHER_MAX_SESSIONS` |
| cells per session | 512 | `MATH_GRAPHER_MAX_CELLS` |
| recompute budget per call | 250 ms | `MATH_GRAPHER_EVAL_BUDGET_MS` |
| max payload per `set`/`define` | 256 KB | `MATH_GRAPHER_MAX_PAYLOAD_BYTES` |

Exceeding a limit is a structured tool error, never a crash. Defaults are
deliberately modest; the env overrides exist so a heavy user can raise
them without a release.

## 10. Preset compute dependencies

The `graph-theory` preset's ops wire directly to **@johnhenry/math's
published `Graph` class** (`hasCycle`, `connectedComponents`,
`stronglyConnectedComponents`, `topologicalSort`, BFS/DFS/Dijkstra,
`toAdjacencyMatrix`) with grapher's own small edge-list parser. No
dependency on mallory — byte-for-byte parity with
`GraphTheoryPanel`'s in-app helpers is a non-goal; contract parity
(same operations, same reactive shape) is the goal.

## Implementation order

1. Scaffold (package.json, tsconfig, node:test, CI) + vendored
   `cell-graph.ts` — the family's usual TS/ESM conventions. (Since
   superseded: see §6 — the vendored copy is now deleted in favor of
   `@johnhenry/math`.)
2. Session table + serialization queue + guards (§3, §9).
3. Op catalog + define-spec interpreter (§5) — the core novel piece,
   tested op-by-op and against the spike's edge-list → BFS fixture.
4. MCP tool surface over it (§8) + `graph-theory` preset (§2, §10) —
   [#3](https://github.com/johnhenry/mallory-grapher/issues/3).
5. stdio CLI + HTTP entries (§7).
6. Separately: @johnhenry/math `CellGraph` upstreaming PR; swap on
   publish (§6, done).

Steps 2–3 are [#2](https://github.com/johnhenry/mallory-grapher/issues/2)'s
scope; step 4 is [#3](https://github.com/johnhenry/mallory-grapher/issues/3);
[#4](https://github.com/johnhenry/mallory-grapher/issues/4) stays parked
until all of this is real.

> **Post-v1 amendment (2026-08-20):** #4 (mounting grapher inside
> mallory's `/api/mcp`) was **closed as not planned** — the mount
> would tie stateful sessions to mallory's frequent-redeploy,
> maybe-scaled container lifecycle, invert §4's opt-in security posture on
> a publicly-reachable endpoint, and put the session server's memory blast
> radius inside the live SSR site. Full reasoning in
> [#4's closing comment](https://github.com/johnhenry/mallory-grapher/issues/4#issuecomment-5345150726).
> Local stdio is the supported path; if remote agents ever need grapher,
> the right shape is a separate gated Dokku app (bearer-token auth,
> tightened limits, memory cap), filed as its own issue when a concrete
> consumer exists.
