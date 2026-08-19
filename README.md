# mallory-grapher

A headless, DOM-less session runtime for the `mallory` family's reactive
compute graph (`CellGraph`), agent-drivable over MCP.

## Why this exists

`mallory-graph`'s in-page WebMCP tools (`useCellGraphTools`:
`${prefix}_list_cells`/`get_cell`/`set_cell`) already let an agent drive a
*live, reactive* `CellGraph` — but only from inside a rendered browser tab.
The server-side MCP endpoint mallory-graph ships today (`mallory-mcp`,
`packages/mcp` in `mallory-plus`) only covers **stateless** math tools
(Symbolic eval, guarded tensor/linalg) plus **read-only, serialized**
gallery access (`gallery_list`/`gallery_get` read `NotebookState.blocks[]`
JSON — no computed/derived-cell evaluation, no reactivity).

Real session parity — "an agent could run an entire modeling session
headlessly" — means running the reactive compute graph itself server-side,
with no DOM/React tree at all. That's a materially different, bigger
project than either of the above, so it lives here instead of inside
mallory-graph.

Split out of [mallory-graph#163](https://github.com/johnhenry/mallory-graph/issues/163)
after that issue's own audit trail: a feasibility spike
(`cell-graph-headless-spike.test.ts`) already confirmed `CellGraph` itself
has zero `window`/`document` references — `set`/`define`/`get`/
`subscribe`/`subscribeAll` are plain data-structure + closure code. What
doesn't exist yet is the actual session API around it.

## Relationship to mallory-graph

**Optional, not coupled.** mallory-grapher does not depend on
mallory-graph, and mallory-graph does not need to depend on
mallory-grapher to function. mallory-graph *may* choose to mount a
mallory-grapher-backed MCP route the same way it mounts `mallory-mcp`
today (`src/routes/api.mcp.ts`) — a separate integration issue, not a
prerequisite for this repo to exist or ship v1.

Concretely, this repo owns:
- The headless session runtime (open a session, drive its cells, read
  results) — no rendering, no React, no DOM.
- An MCP tool surface over that runtime.

It deliberately does NOT own:
- Canvas/WebGL rendering — session parity is about the same get/set/list
  *contract* WebMCP already gives an in-page agent, not pixels.
- mallory-graph's specific panel components, gallery storage, or UI.

## What's known so far (carried over from #163's audit)

- `CellGraph`'s core (`cell-graph.ts` in mallory-graph, ~500 lines) has no
  structural blocker to running headless — proven empirically, not just
  asserted.
- Most panels' `useXGraph()` seed step reads `window.location.hash` /
  `getComputedStyle` for URL-state hydration and theming. Both are
  already guarded with `typeof window !== "undefined"` checks (existing
  SSR-safety code), so they degrade gracefully rather than crash — but a
  real agent-drivable session needs a way to seed state from something
  other than a browser's URL bar (an MCP tool argument, presumably).
- Write-path auth precedent: mallory-graph's `gallery_save` tool
  (#163 item 1, shipped) is gated OFF by default behind an explicit
  env var (`MALLORY_GRAPH_ENABLE_MCP_WRITE=1`), mirroring `llmtm`'s
  `LLMTM_HUB_ENABLE_*` convention. A session-runtime write surface should
  follow the same default-off, explicit-opt-in posture.

## Status

Pre-design. See the issue tracker for the actual scoping work — this
README is a starting point, not a spec.
