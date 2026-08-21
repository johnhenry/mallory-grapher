/**
 * The MCP tool surface (docs/design.md §8) over the session runtime --
 * `session_*` names mirroring the in-page WebMCP trio
 * (`list_cells`/`get_cell`/`set_cell`) so "same contract, just remote" is
 * self-evident, prefixed so the tools coexist unambiguously next to other
 * servers'.
 *
 * `buildServer()` is transport-agnostic (mallory-mcp's own pattern, §7):
 * the stdio CLI and the HTTP entry both call it against ONE shared
 * `SessionTable` -- sessions belong to the process, not to any single MCP
 * connection.
 *
 * A running server IS the write opt-in (§4): no per-tool env gates here.
 * If this ever gets mounted inside an always-on host (mallory-graph's
 * /api/mcp, grapher issue #4), the MOUNT must add its own gate.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OP_CATALOG } from "./ops.ts";
import { PRESETS, type SessionKind } from "./presets.ts";
import { SessionError, SessionTable } from "./session.ts";

interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function err(e: unknown): ToolResult {
  const message = e instanceof SessionError || e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const SESSION_KINDS = Object.keys(PRESETS) as [SessionKind, ...SessionKind[]];

/** Every op with its self-documenting description -- inlined into session_define's own description so an agent can discover the catalog without a separate round-trip. */
const CATALOG_DOC = Object.entries(OP_CATALOG)
  .map(([name, entry]) => `- ${name}: ${entry.description}`)
  .join("\n");

export function buildServer(table: SessionTable = new SessionTable()): McpServer {
  const server = new McpServer({ name: "mallory-grapher", version: "0.0.0" });

  server.registerTool(
    "session_open",
    {
      description: `Open a reactive cell session. kind "generic" starts empty; "graph-theory" pre-wires an edge-list -> analysis -> BFS pipeline (input cells: edgeListText, directed, startVertex; computed cells: parsed, analysis, bfsOrder). Optional seed sets input cells in the same call (overriding preset defaults). Sessions are in-memory and die with the server.`,
      inputSchema: {
        kind: z.enum(SESSION_KINDS),
        seed: z.record(z.string(), z.unknown()).optional(),
      },
    },
    ({ kind, seed }) => {
      try {
        return ok(table.open(kind, seed));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_close",
    {
      description: "Close a session and free its cells.",
      inputSchema: { sessionId: z.string() },
    },
    ({ sessionId }) => {
      try {
        return ok(table.close(sessionId));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_list",
    {
      description: "List open sessions with kind, cell count, and creation time.",
      inputSchema: {},
    },
    () => {
      try {
        return ok(table.list());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_set_cell",
    {
      description: "Set an input cell's value (any JSON). Setting a previously-computed cell demotes it to a plain input. Dependent computed cells recompute lazily on their next get.",
      inputSchema: { sessionId: z.string(), cell: z.string(), value: z.unknown() },
    },
    async ({ sessionId, cell, value }) => {
      try {
        return ok(await table.setCell(sessionId, cell, value));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_get_cell",
    {
      description: 'Read a cell\'s current value (recomputing it if stale). Rich values project to typed JSON (a graph cell returns { "$type": "graph", vertices, edges, directed }).',
      inputSchema: { sessionId: z.string(), cell: z.string() },
    },
    async ({ sessionId, cell }) => {
      try {
        return ok(await table.getCell(sessionId, cell));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_list_cells",
    {
      description: 'List every cell in a session with its role ("free" input vs "computed") and, for computed cells, the op that defines it.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      try {
        return ok(await table.listCells(sessionId));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_explain_cell",
    {
      description:
        'Explain a cell\'s own derivation (issue #5): its role (free input vs computed), the op and raw args that defined it (if computed), its immediate upstream cells with their current values, and its own current value. One level only -- call again on a listed dependency\'s "cell" name to go deeper.',
      inputSchema: { sessionId: z.string(), cell: z.string() },
    },
    async ({ sessionId, cell }) => {
      try {
        return ok(await table.explainCell(sessionId, cell));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "session_define",
    {
      description: `Define a computed cell from a catalog op. args values may be literal JSON or live cell references ({"$cell": "name"}) -- referenced cells become reactive dependencies, so the cell recomputes when they change. Available ops:\n${CATALOG_DOC}`,
      inputSchema: {
        sessionId: z.string(),
        cell: z.string(),
        op: z.string(),
        args: z.record(z.string(), z.unknown()),
      },
    },
    async ({ sessionId, cell, op, args }) => {
      try {
        return ok(await table.define(sessionId, { cell, op, args }));
      } catch (e) {
        return err(e);
      }
    },
  );

  return server;
}
