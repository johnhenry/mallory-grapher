# math-grapher

A headless, DOM-less session runtime for the `@johnhenry/math` family's reactive
compute graph (`CellGraph`), agent-drivable over MCP.

## Why this exists

`mallory`'s (the graphing-calculator app, formerly `mallory-graph`)
in-page WebMCP tools (`useCellGraphTools`:
`${prefix}_list_cells`/`get_cell`/`set_cell`) already let an agent drive a
*live, reactive* `CellGraph` — but only from inside a rendered browser tab.
The server-side MCP endpoint mallory ships today (`@johnhenry/math-plus-mcp`,
math-plus's `packages/mcp`) only covers **stateless** math tools
(Symbolic eval, guarded tensor/linalg) plus **read-only, serialized**
gallery access (`gallery_list`/`gallery_get` read `NotebookState.blocks[]`
JSON — no computed/derived-cell evaluation, no reactivity).

Real session parity — "an agent could run an entire modeling session
headlessly" — means running the reactive compute graph itself server-side,
with no DOM/React tree at all. That's a materially different, bigger
project than either of the above, so it lives here instead of inside
mallory.

Split out of [mallory#163](https://github.com/johnhenry/mallory/issues/163)
after that issue's own audit trail: a feasibility spike
(`cell-graph-headless-spike.test.ts`) already confirmed `CellGraph` itself
has zero `window`/`document` references — `set`/`define`/`get`/
`subscribe`/`subscribeAll` are plain data-structure + closure code. What
doesn't exist yet is the actual session API around it.

## Relationship to mallory

**Optional, not coupled.** math-grapher does not depend on
mallory (the app), and mallory does not need to depend on
math-grapher to function. mallory *may* choose to mount a
math-grapher-backed MCP route the same way it mounts `@johnhenry/math-plus-mcp`
today (`src/routes/api.mcp.ts`) — a separate integration issue, not a
prerequisite for this repo to exist or ship v1.

Concretely, this repo owns:
- The headless session runtime (open a session, drive its cells, read
  results) — no rendering, no React, no DOM.
- An MCP tool surface over that runtime.

It deliberately does NOT own:
- Canvas/WebGL rendering — session parity is about the same get/set/list
  *contract* WebMCP already gives an in-page agent, not pixels.
- mallory's specific panel components, gallery storage, or UI.

## What's known so far (carried over from #163's audit)

- `CellGraph`'s core (`cell-graph.ts` in mallory, ~500 lines) has no
  structural blocker to running headless — proven empirically, not just
  asserted.
- Most panels' `useXGraph()` seed step reads `window.location.hash` /
  `getComputedStyle` for URL-state hydration and theming. Both are
  already guarded with `typeof window !== "undefined"` checks (existing
  SSR-safety code), so they degrade gracefully rather than crash — but a
  real agent-drivable session needs a way to seed state from something
  other than a browser's URL bar (an MCP tool argument, presumably).
- Write-path auth precedent: mallory's `gallery_save` tool
  (#163 item 1, shipped) is gated OFF by default behind an explicit
  env var (`MALLORY_GRAPH_ENABLE_MCP_WRITE=1`), mirroring `llmtm`'s
  `LLMTM_HUB_ENABLE_*` convention. A session-runtime write surface should
  follow the same default-off, explicit-opt-in posture.

## Status

**v1 implemented.** [docs/design.md](docs/design.md) is the settled
design; the session runtime, op catalog, MCP tool surface, and both
transports are built and tested.

## Usage

```bash
# stdio (the transport MCP hosts speak natively -- e.g. `claude mcp add`)
npx math-grapher

# Streamable HTTP on http://localhost:3920/mcp (or a custom port)
npx math-grapher --http
npx math-grapher --http 8123
```

Tools: `session_open` (kind `generic` or `graph-theory`), `session_close`,
`session_list`, `session_set_cell`, `session_get_cell`,
`session_list_cells`, `session_explain_cell` (a cell's own op/args/
immediate dependencies with their current values, one level -- issue #5),
`session_snapshot`/`session_resume` (serialize a session's free-cell
values + define-specs; reconstruct an equivalent session, possibly on a
different process -- issue #6), `session_define`. Computed cells are
declared as
JSON define-specs over a server-side op catalog (`math_eval`,
`graph_parse_edge_list`, `graph_analyze`, `graph_bfs`/`dfs`/`dijkstra`)
with `{"$cell": "name"}` live references — see
[docs/design.md §5](docs/design.md). An op MAY declare a
`requiresCapability` (issue #7); `session_define` rejects it unless
`session_open`/`session_resume`'s own optional `capabilities` arg granted
it for that session (default none — matching the existing write-path
gating precedent below, just per-op instead of one global switch). No op
in the catalog above declares one yet.

Resource guards default modest and are overridable:
`MATH_GRAPHER_MAX_SESSIONS` (16), `MATH_GRAPHER_MAX_CELLS` (512),
`MATH_GRAPHER_EVAL_BUDGET_MS` (250), `MATH_GRAPHER_MAX_PAYLOAD_BYTES`
(262144).
