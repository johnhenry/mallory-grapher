import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { extractCellRefs, parseEdgeListText, projectValue, type OpCatalog } from "../src/ops.ts";
import { SessionError, SessionTable } from "../src/session.ts";

// ---- op catalog --------------------------------------------------------

test("parseEdgeListText: parses `from to weight` lines, defaults weight to 1, single token = isolated vertex", () => {
  const g = parseEdgeListText("A B 4\nC D\nE", true);
  assert.deepEqual(g.vertices().sort(), ["A", "B", "C", "D", "E"]);
  const edges = g.edges();
  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.from === "A" && e.to === "B" && e.weight === 4));
  assert.ok(edges.some((e) => e.from === "C" && e.to === "D" && e.weight === 1));
});

test("parseEdgeListText: rejects empty input, bad token counts, and non-numeric weights", () => {
  assert.throws(() => parseEdgeListText("", true), /empty/);
  assert.throws(() => parseEdgeListText("A B 1 extra", true), /bad edge line/);
  assert.throws(() => parseEdgeListText("A B x", true), /bad weight/);
});

test("projectValue: a Graph projects to typed JSON, a Map to entries, plain JSON passes through", () => {
  const g = parseEdgeListText("A B 2", false);
  const projected = projectValue(g) as { $type: string; directed: boolean; vertices: string[]; edges: unknown[] };
  assert.equal(projected.$type, "graph");
  assert.equal(projected.directed, false);
  assert.deepEqual(projected.vertices.sort(), ["A", "B"]);
  assert.deepEqual(projectValue(new Map([["k", 1]])), { $type: "map", entries: [["k", 1]] });
  assert.deepEqual(projectValue({ plain: true }), { plain: true });
});

// ---- session lifecycle -------------------------------------------------

test("open/list/close: a generic session opens empty, lists, and closes", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  assert.equal(table.list().length, 1);
  assert.equal(table.list()[0]!.kind, "generic");
  assert.deepEqual(await table.listCells(sessionId), []);
  assert.deepEqual(table.close(sessionId), { closed: true });
  assert.equal(table.list().length, 0);
});

test("operations against an unknown/closed session throw a SessionError, not a crash", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  table.close(sessionId);
  assert.throws(() => table.close(sessionId), SessionError);
  await assert.rejects(table.getCell(sessionId, "x"), SessionError);
});

test("open: unknown kind throws a SessionError naming the valid kinds", () => {
  const table = new SessionTable();
  assert.throws(() => table.open("nope" as never), /generic.*graph-theory|graph-theory.*generic/);
});

// ---- set/get/define: the generic core ------------------------------------

test("set_cell + get_cell round-trip plain JSON", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "x", 42);
  assert.deepEqual(await table.getCell(sessionId, "x"), { value: 42 });
});

test("get_cell on a never-set cell throws a SessionError pointing at session_list_cells", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await assert.rejects(table.getCell(sessionId, "ghost"), /session_list_cells/);
});

test("define + $cell refs: math_eval recomputes reactively when an upstream cell changes", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 3);
  await table.define(sessionId, { cell: "doubled", op: "math_eval", args: { expr: "2 * a", vars: { a: { $cell: "a" } } } });
  assert.deepEqual(await table.getCell(sessionId, "doubled"), { value: 6 });
  await table.setCell(sessionId, "a", 10);
  assert.deepEqual(await table.getCell(sessionId, "doubled"), { value: 20 });
});

test("define: unknown op throws a SessionError listing the catalog", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await assert.rejects(table.define(sessionId, { cell: "x", op: "nope", args: {} }), /math_eval/);
});

// ---- extractCellRefs (issue #5's provenance building block) --------------

test("extractCellRefs: finds $cell markers nested in objects and arrays, ignores plain values, dedupes repeats", () => {
  assert.deepEqual(extractCellRefs({ expr: "a + b", vars: { a: { $cell: "a" }, b: { $cell: "b" } } }).sort(), ["a", "b"]);
  assert.deepEqual(extractCellRefs({ list: [{ $cell: "x" }, 1, "plain", { $cell: "x" }] }), ["x"]);
  assert.deepEqual(extractCellRefs({ flat: 1, other: "no refs here" }), []);
});

// ---- explainCell (issue #5) -----------------------------------------------

test("explainCell: a free (input) cell reports role 'free', its value, and no dependencies", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 3);
  assert.deepEqual(await table.explainCell(sessionId, "a"), { cell: "a", role: "free", dependencies: [], value: 3 });
});

test("explainCell: a computed cell reports its op, raw args ($cell markers included), immediate dependencies with their current values, and its own value", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 3);
  await table.define(sessionId, { cell: "doubled", op: "math_eval", args: { expr: "2 * a", vars: { a: { $cell: "a" } } } });
  const explanation = await table.explainCell(sessionId, "doubled");
  assert.equal(explanation.role, "computed");
  assert.equal(explanation.op, "math_eval");
  assert.deepEqual(explanation.args, { expr: "2 * a", vars: { a: { $cell: "a" } } });
  assert.deepEqual(explanation.dependencies, [{ cell: "a", value: 3 }]);
  assert.equal(explanation.value, 6);
});

test("explainCell: reflects the CURRENT dependency value, not a stale one, after an upstream set", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 3);
  await table.define(sessionId, { cell: "doubled", op: "math_eval", args: { expr: "2 * a", vars: { a: { $cell: "a" } } } });
  await table.setCell(sessionId, "a", 10);
  const explanation = await table.explainCell(sessionId, "doubled");
  assert.deepEqual(explanation.dependencies, [{ cell: "a", value: 10 }]);
  assert.equal(explanation.value, 20);
});

test("explainCell: a cell referenced by a define but never itself set/defined throws the same 'no value' error explaining it directly as get_cell would (consistent with the rest of the API, not a special case)", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.define(sessionId, { cell: "y", op: "math_eval", args: { expr: "ghost + 1", vars: { ghost: { $cell: "ghost" } } } });
  await assert.rejects(table.getCell(sessionId, "ghost"), /session_list_cells/);
  await assert.rejects(table.explainCell(sessionId, "ghost"), /session_list_cells/);
});

test("explainCell: a dependency that WAS explicitly set (even to null) reports its real value, not a throw -- only a truly never-set/defined cell throws", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", null);
  // "note" is a $cell ref extractCellRefs still finds (it walks the whole
  // args object), but math_eval's own fn never reads it, so the compute
  // doesn't validate "a" as a number -- isolates "does explainCell report
  // a set-to-null dependency's value" from "does the op itself accept null".
  await table.define(sessionId, { cell: "wraps", op: "math_eval", args: { expr: "1", note: { $cell: "a" } } });
  const explanation = await table.explainCell(sessionId, "wraps");
  assert.deepEqual(explanation.dependencies, [{ cell: "a", value: null }]);
});

// ---- snapshot/resume (issue #6) -------------------------------------------

test("snapshot: captures free-cell values and define-specs, not computed-cell cache", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 3);
  await table.define(sessionId, { cell: "doubled", op: "math_eval", args: { expr: "2 * a", vars: { a: { $cell: "a" } } } });
  await table.getCell(sessionId, "doubled"); // force a compute, to prove the cache isn't what gets captured
  const snapshot = await table.snapshot(sessionId);
  assert.equal(snapshot.v, 1);
  assert.equal(snapshot.kind, "generic");
  assert.deepEqual(snapshot.free, { a: 3 });
  assert.deepEqual(snapshot.defines, [{ cell: "doubled", op: "math_eval", args: { expr: "2 * a", vars: { a: { $cell: "a" } } } }]);
});

test("resume: reconstructs an equivalent session on the SAME table, with a NEW sessionId, that recomputes correctly", async () => {
  const table = new SessionTable();
  const { sessionId: original } = table.open("generic");
  await table.setCell(original, "a", 3);
  await table.define(original, { cell: "doubled", op: "math_eval", args: { expr: "2 * a", vars: { a: { $cell: "a" } } } });
  const snapshot = await table.snapshot(original);

  const { sessionId: resumed } = table.resume(snapshot);
  assert.notEqual(resumed, original);
  assert.deepEqual(await table.getCell(resumed, "a"), { value: 3 });
  assert.deepEqual(await table.getCell(resumed, "doubled"), { value: 6 });
  // Reactivity survives the round trip -- resumed is a live session, not a frozen copy.
  await table.setCell(resumed, "a", 10);
  assert.deepEqual(await table.getCell(resumed, "doubled"), { value: 20 });
});

test("resume: does NOT re-apply the kind's own preset seed -- only what's in the snapshot's own free values", async () => {
  const table = new SessionTable();
  const { sessionId: original } = table.open("graph-theory");
  await table.setCell(original, "startVertex", "C"); // change from the preset's own default "A"
  const snapshot = await table.snapshot(original);
  const { sessionId: resumed } = table.resume(snapshot);
  assert.deepEqual(await table.getCell(resumed, "startVertex"), { value: "C" }, "must reflect the changed value, not silently revert to the preset default");
});

test("resume: rejects an unsupported snapshot version", () => {
  const table = new SessionTable();
  assert.throws(() => table.resume({ v: 2 as never, kind: "generic", free: {}, defines: [] }), /unsupported snapshot version/);
});

test("resume: rejects an unknown session kind", () => {
  const table = new SessionTable();
  assert.throws(() => table.resume({ v: 1, kind: "nope" as never, free: {}, defines: [] }), /unknown session kind/);
});

test("resume: rejects a define-spec with an unknown op, same guard as a live session_define call", () => {
  const table = new SessionTable();
  assert.throws(() => table.resume({ v: 1, kind: "generic", free: {}, defines: [{ cell: "x", op: "nope", args: {} }] }), /math_eval/);
});

test("resume: respects the session-limit guard on the resuming side", () => {
  const table = new SessionTable({ maxSessions: 1, maxCells: 100, evalBudgetMs: 1000, maxPayloadBytes: 65536 });
  table.open("generic");
  assert.throws(() => table.resume({ v: 1, kind: "generic", free: {}, defines: [] }), /session limit reached/);
});

test("resume: respects the cell-count guard on the resuming side, even if the original session was under a looser limit when it was snapshotted", async () => {
  const roomyTable = new SessionTable({ maxSessions: 16, maxCells: 10, evalBudgetMs: 1000, maxPayloadBytes: 65536 });
  const { sessionId } = roomyTable.open("generic");
  for (let i = 0; i < 5; i++) await roomyTable.setCell(sessionId, `c${i}`, i);
  const snapshot = await roomyTable.snapshot(sessionId);

  const strictTable = new SessionTable({ maxSessions: 16, maxCells: 3, evalBudgetMs: 1000, maxPayloadBytes: 65536 });
  assert.throws(() => strictTable.resume(snapshot), /cell limit reached/);
});

// ---- capability-gated ops (issue #7) ---------------------------------------

/** A synthetic catalog with one plain op and one capability-gated op, injected into a SessionTable rather than adding a fake entry to the real production OP_CATALOG. */
const TEST_CATALOG: OpCatalog = {
  plain_add_one: { description: "test-only: value + 1", fn: (args) => (args.value as number) + 1 },
  gated_write: { description: "test-only: pretends to perform a write", requiresCapability: "write", fn: () => "wrote" },
};

test("applyDefine: a session with NO granted capabilities can use a plain (ungated) op", async () => {
  const table = new SessionTable(undefined, TEST_CATALOG);
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "v", 1);
  await table.define(sessionId, { cell: "result", op: "plain_add_one", args: { value: { $cell: "v" } } });
  assert.deepEqual(await table.getCell(sessionId, "result"), { value: 2 });
});

test("applyDefine: a session with NO granted capabilities is rejected from defining a capability-gated op, BEFORE the op ever runs", async () => {
  const table = new SessionTable(undefined, TEST_CATALOG);
  const { sessionId } = table.open("generic");
  await assert.rejects(table.define(sessionId, { cell: "x", op: "gated_write", args: {} }), /requires capability "write"/);
  // The define itself must have been rejected, not just deferred -- the cell was never even registered.
  assert.deepEqual(await table.listCells(sessionId), []);
});

test("applyDefine: a session opened WITH the matching capability may define and use the gated op", async () => {
  const table = new SessionTable(undefined, TEST_CATALOG);
  const { sessionId } = table.open("generic", undefined, ["write"]);
  await table.define(sessionId, { cell: "x", op: "gated_write", args: {} });
  assert.deepEqual(await table.getCell(sessionId, "x"), { value: "wrote" });
});

test("applyDefine: an UNRELATED granted capability doesn't satisfy a different requirement", async () => {
  const table = new SessionTable(undefined, TEST_CATALOG);
  const { sessionId } = table.open("generic", undefined, ["read-only-extra"]);
  await assert.rejects(table.define(sessionId, { cell: "x", op: "gated_write", args: {} }), /requires capability "write"/);
});

test("resume: capabilities are NOT carried forward from the original session -- resuming a snapshot that used a gated op WITHOUT re-granting the capability fails outright (can't even reconstruct the define), and succeeds once it's re-granted", async () => {
  const table = new SessionTable(undefined, TEST_CATALOG);
  const { sessionId: original } = table.open("generic", undefined, ["write"]);
  await table.define(original, { cell: "x", op: "gated_write", args: {} });
  const snapshot = await table.snapshot(original);

  // resume() itself replays snapshot.defines -- with no capabilities arg,
  // re-applying the gated "x" define fails the same way a live
  // session_define call would, so the WHOLE resume fails, not just a
  // later use of the cell.
  assert.throws(() => table.resume(snapshot), /requires capability "write"/);

  const { sessionId: resumedWithCap } = table.resume(snapshot, ["write"]);
  assert.deepEqual(await table.getCell(resumedWithCap, "x"), { value: "wrote" });
});

test("resume: a snapshot with NO gated defines resumes fine without any capabilities, even if the original session happened to hold some", async () => {
  const table = new SessionTable(undefined, TEST_CATALOG);
  const { sessionId: original } = table.open("generic", undefined, ["write"]); // granted, but never used by a define
  await table.setCell(original, "a", 1);
  await table.define(original, { cell: "b", op: "plain_add_one", args: { value: { $cell: "a" } } });
  const snapshot = await table.snapshot(original);

  const { sessionId: resumed } = table.resume(snapshot); // no capabilities arg -- fine, nothing in the snapshot needs one
  assert.deepEqual(await table.getCell(resumed, "b"), { value: 2 });
  await assert.rejects(table.define(resumed, { cell: "x", op: "gated_write", args: {} }), /requires capability "write"/, "the resumed session itself has no capabilities, even though the original did");
});

test("the real production OP_CATALOG has no capability-gated ops yet -- every current op is pure/read-only, so a default (no-capability) session can use all of them", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 3);
  // math_eval is the simplest real op to exercise; if this ever starts
  // throwing "requires capability", it means someone added a requirement
  // to a real catalog entry without a session granting it in this test.
  await table.define(sessionId, { cell: "b", op: "math_eval", args: { expr: "a + 1", vars: { a: { $cell: "a" } } } });
  assert.deepEqual(await table.getCell(sessionId, "b"), { value: 4 });
});

test("set over a computed cell demotes it to a free cell (list_cells role flips)", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 1);
  await table.define(sessionId, { cell: "b", op: "math_eval", args: { expr: "a + 1", vars: { a: { $cell: "a" } } } });
  assert.deepEqual((await table.listCells(sessionId)).find((c) => c.cell === "b"), { cell: "b", role: "computed", op: "math_eval" });
  await table.setCell(sessionId, "b", 99);
  assert.deepEqual((await table.listCells(sessionId)).find((c) => c.cell === "b"), { cell: "b", role: "free" });
  assert.deepEqual(await table.getCell(sessionId, "b"), { value: 99 });
});

// ---- the graph-theory preset: the spike's own fixture ---------------------

test("graph-theory preset: the headless spike's edge-list -> BFS pipeline works end-to-end with the same fixture and result", async () => {
  const table = new SessionTable();
  // Same seed the preset defaults to == the spike's fixture (mallory's
  // cell-graph-headless-spike.test.ts: "A B 4\nA C 2\nC B 1\nB D 5",
  // undirected, start A -> BFS order [A, B, C, D]).
  const { sessionId } = table.open("graph-theory");
  assert.deepEqual(await table.getCell(sessionId, "bfsOrder"), { value: ["A", "B", "C", "D"] });
  const analysis = (await table.getCell(sessionId, "analysis")).value as { hasCycle: boolean; connectedComponents: string[][] };
  assert.equal(analysis.hasCycle, true);
  assert.equal(analysis.connectedComponents.length, 1);
});

test("graph-theory preset: setting edgeListText recomputes the whole chain (live session parity, not a frozen snapshot)", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("graph-theory");
  await table.setCell(sessionId, "edgeListText", "X Y\nY Z");
  await table.setCell(sessionId, "startVertex", "X");
  assert.deepEqual(await table.getCell(sessionId, "bfsOrder"), { value: ["X", "Y", "Z"] });
});

test("graph-theory preset: open-call seed overrides the preset's defaults", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("graph-theory", { edgeListText: "P Q", startVertex: "P" });
  assert.deepEqual(await table.getCell(sessionId, "bfsOrder"), { value: ["P", "Q"] });
});

test("graph-theory preset: get_cell on the graph cell returns the typed projection, not an opaque object", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("graph-theory");
  const { value } = await table.getCell(sessionId, "parsed");
  assert.equal((value as { $type: string }).$type, "graph");
});

// ---- guards --------------------------------------------------------------

test("guard: session limit", () => {
  const table = new SessionTable({ ...DEFAULT_LIMITS, maxSessions: 2 });
  table.open("generic");
  table.open("generic");
  assert.throws(() => table.open("generic"), /session limit/);
});

test("guard: cell limit counts existing cells but allows overwriting one", async () => {
  const table = new SessionTable({ ...DEFAULT_LIMITS, maxCells: 2 });
  const { sessionId } = table.open("generic");
  await table.setCell(sessionId, "a", 1);
  await table.setCell(sessionId, "b", 2);
  await assert.rejects(table.setCell(sessionId, "c", 3), /cell limit/);
  await table.setCell(sessionId, "a", 99); // overwrite is fine at the cap
});

test("guard: payload limit rejects an oversized set", async () => {
  const table = new SessionTable({ ...DEFAULT_LIMITS, maxPayloadBytes: 64 });
  const { sessionId } = table.open("generic");
  await assert.rejects(table.setCell(sessionId, "big", "x".repeat(1000)), /payload limit/);
});

test("guard: a failed call doesn't poison the session's queue for the next call", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  await assert.rejects(table.getCell(sessionId, "missing"));
  await table.setCell(sessionId, "x", 1);
  assert.deepEqual(await table.getCell(sessionId, "x"), { value: 1 });
});

test("serialization: interleaved calls against one session apply in submission order", async () => {
  const table = new SessionTable();
  const { sessionId } = table.open("generic");
  // Fire a burst without awaiting; per-session queueing must apply them in order.
  const writes = [1, 2, 3, 4, 5].map((n) => table.setCell(sessionId, "x", n));
  await Promise.all(writes);
  assert.deepEqual(await table.getCell(sessionId, "x"), { value: 5 });
});
