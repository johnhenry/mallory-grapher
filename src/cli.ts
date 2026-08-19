#!/usr/bin/env node
/**
 * `mallory-grapher` -- run the session server (docs/design.md §7).
 *
 * - Default: stdio, the transport every MCP host speaks natively. The
 *   primary entry: sessions live exactly as long as this process (§1's
 *   in-memory-ephemeral lifetime is literally process lifetime).
 * - `--http [port]` (default 3920): Streamable HTTP. One process, ONE
 *   shared SessionTable; the MCP layer itself runs stateless per request
 *   (the SDK's own documented stateless mode) because grapher's
 *   sessionIds ride inside tool args, not in transport state -- so no
 *   session-affinity plumbing is needed.
 *
 * A running server IS the write opt-in (§4) -- launching this binary is
 * the security decision; there are no further env gates here.
 */
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { limitsFromEnv } from "./limits.ts";
import { buildServer } from "./server.ts";
import { SessionTable } from "./session.ts";

const args = process.argv.slice(2);
const table = new SessionTable(limitsFromEnv());

const httpFlagIndex = args.indexOf("--http");
if (httpFlagIndex === -1) {
  const server = buildServer(table);
  await server.connect(new StdioServerTransport());
} else {
  const portArg = args[httpFlagIndex + 1];
  const port = portArg && /^\d+$/.test(portArg) ? Number(portArg) : 3920;
  const httpServer = createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found -- the MCP endpoint is POST /mcp" }));
      return;
    }
    try {
      // Fresh server+transport per request (the SDK's stateless-mode
      // example); the shared SessionTable above is what actually holds
      // session state across requests.
      const server = buildServer(table);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body.length > 0 ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    }
  });
  httpServer.listen(port, () => {
    console.error(`mallory-grapher: Streamable HTTP on http://localhost:${port}/mcp (sessions are in-memory, per-process)`);
  });
}
