/**
 * The session runtime (docs/design.md §1-§3, §9): an in-memory table of
 * ephemeral sessions, each one a `CellGraph` plus the define-specs that
 * built its computed cells. Calls against one session are serialized
 * through a per-session promise queue (§3) -- `CellGraph` is
 * single-threaded reactive code with no locking, and the queue preserves
 * that with zero new machinery inside the graph itself. Distinct sessions
 * are fully independent.
 */
import { randomUUID } from "node:crypto";
import { CellGraph } from "./cell-graph.ts";
import { DEFAULT_LIMITS, type SessionLimits } from "./limits.ts";
import { extractCellRefs, isCellRef, OP_CATALOG, projectValue, type DefineSpec } from "./ops.ts";
import { PRESETS, type SessionKind } from "./presets.ts";

/** A structured, caller-fixable failure (bad args, limit exceeded, unknown id) -- the MCP surface maps these to tool errors; anything else is a bug. */
export class SessionError extends Error {}

export interface SessionInfo {
  sessionId: string;
  kind: SessionKind;
  cellCount: number;
  createdAt: string;
}

/**
 * A cell's own derivation (issue #5's provenance/audit trail): what
 * produced it, and the current values of whatever it immediately reads.
 * Deliberately ONE level, not a recursive tree -- an agent that needs to
 * go deeper just calls `explainCell` again on a listed dependency's own
 * `cell` name, same "compose small calls" shape `session_get_cell` and
 * `session_list_cells` already have, rather than this tool guessing how
 * deep is enough and risking an enormous nested payload for a wide graph.
 */
/**
 * A session's portable state (issue #6, the "closure manifest" idea
 * applied to a whole session): free-cell values plus define-specs, NOT
 * computed-cell cache -- those just re-derive from `define()` on resume,
 * cheap by design (`graph.define` is lazy; nothing computes until a
 * later `get`). Free-cell values are ALWAYS plain JSON by construction:
 * the only ways a free cell gets a value are `session_open`'s preset/
 * caller seed and `session_set_cell`, both `Record<string, unknown>`
 * over the MCP boundary (JSON-only) -- a computed cell's own rich value
 * (e.g. a `Graph` instance from `graph_parse_edge_list`) can only ever
 * exist on a COMPUTED cell, never a free one, so there's no rich-value
 * round-trip concern here at all, unlike `session_get_cell`'s
 * `projectValue`.
 */
export interface SessionSnapshot {
  v: 1;
  kind: SessionKind;
  free: Record<string, unknown>;
  defines: DefineSpec[];
}

export interface CellExplanation {
  cell: string;
  role: "free" | "computed";
  op?: string;
  /** Raw args as given to `session_define`, `$cell` markers included -- lets a caller see literal values alongside references without a second round trip. */
  args?: Record<string, unknown>;
  /** This cell's own immediate upstream cells (from `extractCellRefs(args)`), each with its CURRENT value already resolved -- a free cell has none. */
  dependencies: Array<{ cell: string; value: unknown }>;
  value: unknown;
}

interface Session {
  id: string;
  kind: SessionKind;
  graph: CellGraph;
  /** cell -> the spec that defined it, for `session_list_cells`'s `op` field and (v2) serialization. */
  defines: Map<string, DefineSpec>;
  createdAt: string;
  /** Tail of the per-session serialization queue (§3). */
  queue: Promise<unknown>;
}

function payloadBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

export class SessionTable {
  private readonly sessions = new Map<string, Session>();
  private readonly limits: SessionLimits;
  constructor(limits: SessionLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /**
   * Serializes `fn` behind every earlier call against the same session
   * (§3). The queue tail swallows rejections (each caller still gets its
   * own rejection) so one failed call never poisons the queue for the
   * next.
   */
  private enqueue<T>(session: Session, fn: () => T): Promise<T> {
    const result = session.queue.then(fn);
    session.queue = result.catch(() => undefined);
    return result;
  }

  private lookup(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionError(`no such session "${sessionId}" -- it may have expired with a server restart (sessions are in-memory, docs/design.md §1)`);
    return session;
  }

  open(kind: SessionKind, seed?: Record<string, unknown>): { sessionId: string } {
    if (this.sessions.size >= this.limits.maxSessions) {
      throw new SessionError(`session limit reached (${this.limits.maxSessions}) -- close one with session_close, or raise MALLORY_GRAPHER_MAX_SESSIONS`);
    }
    const preset = PRESETS[kind];
    if (!preset) throw new SessionError(`unknown session kind "${kind}" -- expected one of: ${Object.keys(PRESETS).join(", ")}`);
    const session: Session = {
      id: randomUUID(),
      kind,
      graph: new CellGraph(),
      defines: new Map(),
      createdAt: new Date().toISOString(),
      queue: Promise.resolve(),
    };
    // Preset seeds first, then caller seeds (so a caller can override a
    // preset's defaults in the same open call), then preset defines --
    // defines are lazy (nothing computes until a get), so define-over-seed
    // ordering doesn't matter, but seeds must all land before any are
    // observable.
    for (const [cell, value] of Object.entries(preset.seed)) session.graph.set(cell, value);
    if (seed) {
      for (const [cell, value] of Object.entries(seed)) this.applySet(session, cell, value);
    }
    for (const spec of preset.defines) this.applyDefine(session, spec);
    this.sessions.set(session.id, session);
    return { sessionId: session.id };
  }

  close(sessionId: string): { closed: boolean } {
    this.lookup(sessionId);
    this.sessions.delete(sessionId);
    return { closed: true };
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      kind: s.kind,
      cellCount: s.graph.list().length,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Serializes a session's portable state (issue #6): current free-cell
   * values plus define-specs, NOT computed-cell cache (see
   * `SessionSnapshot`'s own doc comment on why that's fine to drop).
   * Enqueued like every other per-session read (`getCell`/`listCells`),
   * so it can't observe a torn state mid another queued call.
   */
  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this.lookup(sessionId);
    return this.enqueue(session, () => {
      const free: Record<string, unknown> = {};
      for (const c of session.graph.list()) {
        if (c.hasValue && !session.defines.has(c.id)) free[c.id] = session.graph.get(c.id);
      }
      return { v: 1 as const, kind: session.kind, free, defines: [...session.defines.values()] };
    });
  }

  /**
   * Reconstructs a session from a `snapshot()` document, on THIS table
   * (possibly a different process than the one that produced the
   * snapshot -- the document is the only thing that needs to travel;
   * resume needs no special cross-process machinery beyond it). Applies
   * free values then defines, same order `open()`'s own preset-seeding
   * uses and for the same reason (defines are lazy, so order between the
   * two groups never matters, but every free value should land before
   * any define might read it via `$cell`).
   *
   * Every guard `applySet`/`applyDefine` already enforce (payload size,
   * cell-count budget, unknown-op) applies exactly the same way here,
   * satisfying issue #6's own "respect the existing guards on the
   * RESUMING side" requirement for free -- reusing those private methods
   * rather than re-deriving the checks is what makes that automatic. The
   * resumed session does NOT re-apply `kind`'s own preset seed -- the
   * snapshot's `free` already contains whatever came from the ORIGINAL
   * session's preset seed at its own open() time (preset seeds become
   * ordinary free cells immediately after seeding), so redoing it here
   * would silently clobber any value the original session's caller had
   * since changed.
   *
   * Deliberately does NOT attempt to resume mid-flight async state or
   * carry forward any notion of prior "authority" -- out of scope per
   * the issue's own explicit v1 boundary; a resumed session is exactly as
   * trusted (or not) as any other freshly-opened one.
   */
  resume(snapshot: SessionSnapshot): { sessionId: string } {
    if (snapshot.v !== 1) throw new SessionError(`unsupported snapshot version ${snapshot.v} -- this server understands v1`);
    if (this.sessions.size >= this.limits.maxSessions) {
      throw new SessionError(`session limit reached (${this.limits.maxSessions}) -- close one with session_close, or raise MALLORY_GRAPHER_MAX_SESSIONS`);
    }
    if (!PRESETS[snapshot.kind]) throw new SessionError(`unknown session kind "${snapshot.kind}" -- expected one of: ${Object.keys(PRESETS).join(", ")}`);
    const session: Session = {
      id: randomUUID(),
      kind: snapshot.kind,
      graph: new CellGraph(),
      defines: new Map(),
      createdAt: new Date().toISOString(),
      queue: Promise.resolve(),
    };
    for (const [cell, value] of Object.entries(snapshot.free)) this.applySet(session, cell, value);
    for (const spec of snapshot.defines) this.applyDefine(session, spec);
    this.sessions.set(session.id, session);
    return { sessionId: session.id };
  }

  private assertCellBudget(session: Session, cell: string): void {
    const existing = session.graph.list();
    if (existing.length >= this.limits.maxCells && !existing.some((c) => c.id === cell)) {
      throw new SessionError(`cell limit reached (${this.limits.maxCells}) -- raise MALLORY_GRAPHER_MAX_CELLS if this is intentional`);
    }
  }

  private applySet(session: Session, cell: string, value: unknown): void {
    if (payloadBytes(value) > this.limits.maxPayloadBytes) {
      throw new SessionError(`value for "${cell}" exceeds the ${this.limits.maxPayloadBytes}-byte payload limit (MALLORY_GRAPHER_MAX_PAYLOAD_BYTES)`);
    }
    this.assertCellBudget(session, cell);
    session.defines.delete(cell); // a set over a computed cell demotes it to a free cell, matching CellGraph's own set-over-define semantics
    session.graph.set(cell, value);
  }

  /**
   * Translates a define-spec into a real `graph.define` whose compute
   * resolves `{ $cell }` references live via `graph.get` -- reactivity
   * comes from CellGraph recording those reads as dependency edges, same
   * as any in-app panel's define chain. The eval budget (§9) is enforced
   * by a deadline set when a tool call starts (see `run`): compute
   * checks it before running, so a long recompute cascade fails fast
   * with a structured error instead of hanging the server. (A single op
   * that overruns internally can't be preempted -- the check is between
   * ops, which is where cascades spend their fan-out anyway.)
   */
  private applyDefine(session: Session, spec: DefineSpec): void {
    if (payloadBytes(spec) > this.limits.maxPayloadBytes) {
      throw new SessionError(`define spec for "${spec.cell}" exceeds the ${this.limits.maxPayloadBytes}-byte payload limit (MALLORY_GRAPHER_MAX_PAYLOAD_BYTES)`);
    }
    const catalogEntry = OP_CATALOG[spec.op];
    if (!catalogEntry) throw new SessionError(`unknown op "${spec.op}" -- expected one of: ${Object.keys(OP_CATALOG).join(", ")}`);
    if (typeof spec.cell !== "string" || spec.cell.length === 0) throw new SessionError("define spec needs a non-empty cell name");
    this.assertCellBudget(session, spec.cell);
    const graph = session.graph;
    const table = this;
    graph.define(spec.cell, () => {
      if (table.deadline !== null && Date.now() > table.deadline) {
        throw new SessionError(`recompute exceeded the ${table.limits.evalBudgetMs}ms eval budget (MALLORY_GRAPHER_EVAL_BUDGET_MS)`);
      }
      const resolved: Record<string, unknown> = {};
      for (const [name, arg] of Object.entries(spec.args)) {
        resolved[name] = resolveArg(graph, arg);
      }
      return catalogEntry.fn(resolved);
    });
    session.defines.set(spec.cell, spec);
  }

  /** Deadline for the recompute cascade of the currently-running call, or null outside one. Single-slot is safe: per-session queues serialize compute, and CellGraph recomputes synchronously inside get(). */
  private deadline: number | null = null;

  private withDeadline<T>(fn: () => T): T {
    this.deadline = Date.now() + this.limits.evalBudgetMs;
    try {
      return fn();
    } finally {
      this.deadline = null;
    }
  }

  // -- public per-session operations, each serialized through the queue --

  async setCell(sessionId: string, cell: string, value: unknown): Promise<{ ok: true }> {
    const session = this.lookup(sessionId);
    return this.enqueue(session, () => {
      this.applySet(session, cell, value);
      return { ok: true as const };
    });
  }

  async getCell(sessionId: string, cell: string): Promise<{ value: unknown }> {
    const session = this.lookup(sessionId);
    return this.enqueue(session, () =>
      this.withDeadline(() => {
        // Computed cells are lazy -- hasValue stays false until the first
        // get actually runs the compute -- so "exists" means either a set
        // value or a registered define, not hasValue alone.
        if (!session.graph.hasValue(cell) && !session.defines.has(cell)) {
          throw new SessionError(`cell "${cell}" has no value in this session -- session_list_cells shows what exists`);
        }
        return { value: projectValue(session.graph.get(cell)) };
      }),
    );
  }

  async explainCell(sessionId: string, cell: string): Promise<CellExplanation> {
    const session = this.lookup(sessionId);
    return this.enqueue(session, () =>
      this.withDeadline(() => {
        if (!session.graph.hasValue(cell) && !session.defines.has(cell)) {
          throw new SessionError(`cell "${cell}" has no value in this session -- session_list_cells shows what exists`);
        }
        const value = projectValue(session.graph.get(cell));
        const spec = session.defines.get(cell);
        if (!spec) return { cell, role: "free" as const, dependencies: [], value };
        const dependencies = extractCellRefs(spec.args).map((dep) => ({
          cell: dep,
          // A referenced cell that was never itself set/defined still
          // resolves (CellGraph auto-creates an empty record on read --
          // see listCells's own comment on the same behavior), so this
          // reports `undefined` for it rather than throwing mid-explanation.
          value: session.graph.hasValue(dep) ? projectValue(session.graph.get(dep)) : undefined,
        }));
        return { cell, role: "computed" as const, op: spec.op, args: spec.args, dependencies, value };
      }),
    );
  }

  async listCells(sessionId: string): Promise<Array<{ cell: string; role: "free" | "computed"; op?: string }>> {
    const session = this.lookup(sessionId);
    return this.enqueue(session, () =>
      session.graph
        .list()
        // A cell that was merely READ (a $cell ref to a never-set name
        // auto-creates an empty record) isn't part of the session's real
        // surface until something sets or defines it.
        .filter((c) => c.hasValue || session.defines.has(c.id))
        .map((c) => {
          const spec = session.defines.get(c.id);
          return spec ? { cell: c.id, role: "computed" as const, op: spec.op } : { cell: c.id, role: "free" as const };
        }),
    );
  }

  async define(sessionId: string, spec: DefineSpec): Promise<{ ok: true }> {
    const session = this.lookup(sessionId);
    return this.enqueue(session, () => {
      this.applyDefine(session, spec);
      return { ok: true as const };
    });
  }
}

function resolveArg(graph: CellGraph, arg: unknown): unknown {
  if (isCellRef(arg)) return graph.get(arg.$cell);
  if (Array.isArray(arg)) return arg.map((item) => resolveArg(graph, item));
  if (typeof arg === "object" && arg !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(arg)) resolved[key] = resolveArg(graph, value);
    return resolved;
  }
  return arg;
}
