#!/usr/bin/env node
/**
 * `npx mallory-grapher` / `mallory-grapher`: run the session server over
 * stdio (docs/design.md §7) -- the transport every MCP host speaks
 * natively, and the primary entry: sessions live exactly as long as this
 * process (§1's in-memory-ephemeral lifetime is literally process
 * lifetime here).
 *
 * The real `buildServer()` lands with issue #3 (MCP tool surface over the
 * session runtime); until then this exits with a clear message rather
 * than pretending to serve.
 */
console.error("mallory-grapher: the session server is not implemented yet -- see https://github.com/johnhenry/mallory-grapher/issues/2");
process.exit(1);
