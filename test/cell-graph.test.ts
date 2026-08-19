import assert from "node:assert/strict";
import { test } from "node:test";
import { CellGraph, CircularDependencyError, structuralEqual } from "../src/cell-graph.ts";

test("set/get a raw source cell", () => {
  const g = new CellGraph();
  g.set("a", 5);
  assert.equal(g.get("a"), 5);
});

test("has() returns true the instant a cell is merely read, even before it's ever been set/defined -- hasValue() does not", () => {
  // This is the exact real-world footgun a production bug traced back to
  // (ExpressionRow.tsx's init guard): a caller elsewhere in the app (e.g. a
  // subscribeAll listener firing reentrant mid-render) reads a not-yet-
  // initialized id via a bare get(), which silently ensure()s an empty
  // record. A later "was this already initialized?" check that uses has()
  // instead of hasValue() is fooled into skipping real initialization.
  const g = new CellGraph();
  assert.equal(g.has("never-touched"), false);
  assert.equal(g.hasValue("never-touched"), false);
  g.get("never-touched"); // a bare read, no set()/define() -- ensure()s an empty record as a side effect
  assert.equal(g.has("never-touched"), true, "has() is fooled by the bare read");
  assert.equal(g.hasValue("never-touched"), false, "hasValue() is not -- no real value was ever produced");
});

test("derived cell recomputes from its dependencies", () => {
  const g = new CellGraph();
  g.set("a", 2);
  g.set("b", 3);
  g.define("sum", () => g.get<number>("a") + g.get<number>("b"));
  assert.equal(g.get("sum"), 5);
  g.set("a", 10);
  assert.equal(g.get("sum"), 13);
});

test("dirty propagates transitively through a chain", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("b", () => g.get<number>("a") * 2);
  g.define("c", () => g.get<number>("b") + 1);
  assert.equal(g.get("c"), 3);
  g.set("a", 5);
  assert.equal(g.get("c"), 11);
});

test("dependencies rebuild fresh on each recompute (conditional deps)", () => {
  const g = new CellGraph();
  g.set("useA", true);
  g.set("a", 1);
  g.set("b", 100);
  g.define("out", () => (g.get<boolean>("useA") ? g.get<number>("a") : g.get<number>("b")));
  assert.equal(g.get("out"), 1);

  // Switch to depending on b instead of a; a's future writes must no longer affect out.
  g.set("useA", false);
  assert.equal(g.get("out"), 100);
  g.set("a", 999);
  assert.equal(g.get("out"), 100);
  g.set("b", 200);
  assert.equal(g.get("out"), 200);
});

test("structural sharing preserves object identity across a no-op recompute", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("parity", () => ({ label: g.get<number>("a") % 2 === 0 ? "even" : "odd" }));

  const first = g.get("parity");
  assert.deepEqual(first, { label: "odd" });
  const versionAfterFirst = g.getVersion("parity");

  // a: 1 -> 3 is a real change, but parity's *output* is structurally the
  // same ("odd") -> the cached reference (and version) must be preserved,
  // which is what lets a downstream Object.is check bail out of a redraw.
  g.set("a", 3);
  const second = g.get("parity");
  assert.equal(second, first, "same reference preserved when recompute is structurally unchanged");
  assert.equal(g.getVersion("parity"), versionAfterFirst);

  // a: 3 -> 4 flips parity to "even" -> genuinely different, new reference.
  g.set("a", 4);
  const third = g.get("parity");
  assert.notEqual(third, first);
  assert.deepEqual(third, { label: "even" });
  assert.ok(g.getVersion("parity") > versionAfterFirst);
});

test("subscribe fires on change, not on a structurally-equal no-op write", () => {
  const g = new CellGraph();
  g.set("a", { x: 1 });
  let calls = 0;
  const unsub = g.subscribe("a", () => calls++);
  g.set("a", { x: 1 }); // structurally equal -> no emit
  assert.equal(calls, 0);
  g.set("a", { x: 2 });
  assert.equal(calls, 1);
  unsub();
  g.set("a", { x: 3 });
  assert.equal(calls, 1);
});

test("subscribeAll fires for changes on any cell", () => {
  const g = new CellGraph();
  g.set("a", 1);
  let calls = 0;
  g.subscribeAll(() => calls++);
  g.set("a", 2);
  g.set("b", 3);
  assert.equal(calls, 2);
});

// subscribeMany (issue #235): several panels' URL-sync/redraw effects used
// subscribeAll purely as a shorthand for "any of these specific cells I
// actually read", which meant they ALSO fired on unrelated high-frequency
// writes elsewhere in the same graph -- a RAF-driven playback clock
// (TIME_CELL), a live drag preview, a per-epoch training metric -- that the
// listener's own output never depended on. These tests model that exact
// shape: a "TIME_CELL"-like hot cell the listener does NOT watch.
test("subscribeMany fires for a write to any watched cell", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.set("b", 1);
  let calls = 0;
  g.subscribeMany(["a", "b"], () => calls++);
  g.set("a", 2);
  g.set("b", 2);
  assert.equal(calls, 2);
});

test("subscribeMany does NOT fire for a write to a cell outside the watched set -- e.g. a RAF-driven clock the listener doesn't read", () => {
  const g = new CellGraph();
  g.set("exprText", "x");
  g.set("TIME_CELL", 0);
  let calls = 0;
  // Mirrors GraphTheoryPanel/ComplexPanel/MlPlaygroundPanel's writeUrl: only
  // watches the cells its serialized output actually reads.
  g.subscribeMany(["exprText"], () => calls++);
  for (let frame = 1; frame <= 60; frame++) g.set("TIME_CELL", frame); // 60 "RAF ticks" of an unrelated clock
  assert.equal(calls, 0, "60 writes to an unwatched cell must not fire a subscribeMany listener even once");
  g.set("exprText", "x^2");
  assert.equal(calls, 1, "a write to a watched cell still fires normally");
});

test("subscribeMany: the returned unsubscribe function detaches every watched id, not just the first", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.set("b", 1);
  let calls = 0;
  const unsubscribe = g.subscribeMany(["a", "b"], () => calls++);
  unsubscribe();
  g.set("a", 2);
  g.set("b", 2);
  assert.equal(calls, 0);
});

test("subscribeMany: a shared-graph multi-block scenario -- writes to a DIFFERENT block's cells don't fire this block's listener (NotebookGraphBlock's fix)", () => {
  const g = new CellGraph();
  // Two notebook blocks sharing one CellGraph, the way NotebookPanel wires
  // every block onto a single document-wide graph.
  g.set("blockA.path", "pathA-v1");
  g.set("blockB.path", "pathB-v1");
  let blockARedraws = 0;
  g.subscribeMany(["blockA.path"], () => blockARedraws++);
  // A slider drag, RAF tick, or training-loop write in block B...
  for (let i = 0; i < 30; i++) g.set("blockB.path", `pathB-v${i}`);
  assert.equal(blockARedraws, 0, "block A's redraw must not fire for block B's own writes");
  // ...but block A's own write still redraws it.
  g.set("blockA.path", "pathA-v2");
  assert.equal(blockARedraws, 1);
});

test("throws on a circular dependency", () => {
  const g = new CellGraph();
  g.define("a", () => g.get<number>("b") + 1);
  g.define("b", () => g.get<number>("a") + 1);
  assert.throws(() => g.get("a"), CircularDependencyError);
});

// The four tests below investigate a specific concern raised while surveying
// this repo for cross-repo interop opportunities (see the mallory-plus
// FAMILY.md doc and this repo's own issue #18): could redefining a cell to
// complete a cycle, at a moment when an INTERMEDIATE cell in that cycle is
// clean/cached (not currently on the live call stack), let a genuine
// circular dependency slip past `stack.includes(id)`'s live-call check?
//
// Empirically -- across every entry point tried below -- the answer is no.
// `propagateDirty()` runs unconditionally at the end of every `set()`/
// `define()` call, REGARDLESS of whether the triggering recompute's result
// was structurally unchanged. The redefine that completes a cycle therefore
// always ends its own call by transitively dirtying every cell reachable
// through the (by-then fully-connected) cycle -- so the very next live
// `get()` on ANY cycle member, no matter which one, forces a fresh walk
// through every dirty member and correctly lands on `stack.includes(id)`.
// These tests exist to lock that in as a regression guard, not to document
// a bug -- see issue #18's closing comment for the full investigation.
test("cycle completed by redefining an existing (previously clean/cached) cell is still caught, read from the cell that completed it", () => {
  const g = new CellGraph();
  g.define("c", () => 5);
  assert.equal(g.get("c"), 5);
  g.define("b", () => g.get<number>("c"));
  assert.equal(g.get("b"), 5); // b reads c while c is a plain leaf -- no cycle yet
  g.define("a", () => g.get<number>("b")); // deliberately not get()'d yet
  g.define("c", () => g.get<number>("a")); // redefine c -- completes a -> b -> c -> a
  assert.throws(() => g.get("c"), CircularDependencyError);
});

test("cycle completed by redefining an existing cell is caught reading the OTHER end (the cell that was clean at completion time)", () => {
  const g = new CellGraph();
  g.define("c", () => 5);
  g.get("c");
  g.define("b", () => g.get<number>("c"));
  g.get("b"); // b clean, cached -- this is the cell that's clean when the cycle completes
  g.define("a", () => g.get<number>("b"));
  g.define("c", () => g.get<number>("a"));
  assert.throws(() => g.get("b"), CircularDependencyError);
});

test("cycle completed by redefining an existing cell is caught reading a THIRD, previously-untouched cell", () => {
  const g = new CellGraph();
  g.define("c", () => 5);
  g.get("c");
  g.define("b", () => g.get<number>("c"));
  g.get("b");
  g.define("a", () => g.get<number>("b"));
  g.define("c", () => g.get<number>("a"));
  assert.throws(() => g.get("a"), CircularDependencyError);
});

test("cycle completed purely via define() (no cell ever computed before the cycle closes) is still caught on the first live get()", () => {
  const g = new CellGraph();
  g.define("b", () => g.get<number>("c"));
  g.get("b"); // auto-vivifies "c" as an empty, compute-less record (not yet defined)
  g.define("c", () => g.get<number>("a")); // "c"'s first REAL define -- completes half the cycle
  g.define("a", () => g.get<number>("b")); // completes the other half
  assert.throws(() => g.get("a"), CircularDependencyError);
});

test("delete detaches a cell from its dependents and dependencies", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("b", () => g.get<number>("a") + 1);
  assert.equal(g.get("b"), 2);
  g.delete("a");
  assert.equal(g.has("a"), false);
  g.set("a", 100);
  // "b" was defined against the old "a" cell instance; a fresh "a" cell means
  // "b" is no longer marked dirty by writes to the new one until re-defined.
  g.define("b", () => g.get<number>("a") + 1);
  assert.equal(g.get("b"), 101);
});

test("role reports free for a set cell, dependent for a define cell, unknown before any value exists", () => {
  const g = new CellGraph();
  assert.equal(g.role("never-touched"), "unknown");
  g.set("a", 1);
  assert.equal(g.role("a"), "free");
  g.define("b", () => g.get<number>("a") + 1);
  assert.equal(g.role("b"), "unknown"); // defined but not yet read/recomputed
  g.get("b");
  assert.equal(g.role("b"), "dependent");
});

test("role updates when a cell transitions between set and define", () => {
  const g = new CellGraph();
  g.set("a", 1);
  assert.equal(g.role("a"), "free");
  g.define("a", () => 2);
  g.get("a");
  assert.equal(g.role("a"), "dependent");
  g.set("a", 3);
  assert.equal(g.role("a"), "free");
});

test("isAuxiliary defaults to false, and is set/preserved per the set/define auxiliary option", () => {
  const g = new CellGraph();
  g.set("a", 1);
  assert.equal(g.isAuxiliary("a"), false);
  g.set("hidden", 1, { auxiliary: true });
  assert.equal(g.isAuxiliary("hidden"), true);
  // A later set() on the same still-free cell without an explicit option
  // leaves the previously-set auxiliary flag alone rather than resetting it.
  g.set("hidden", 2);
  assert.equal(g.isAuxiliary("hidden"), true);
});

test("list enumerates every cell with its role and auxiliary flag", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.set("hidden", 2, { auxiliary: true });
  g.define("b", () => g.get<number>("a") + 1);
  g.get("b");
  const entries = new Map(g.list().map((e) => [e.id, e]));
  assert.deepEqual(entries.get("a"), { id: "a", role: "free", auxiliary: false, hasValue: true });
  assert.deepEqual(entries.get("hidden"), { id: "hidden", role: "free", auxiliary: true, hasValue: true });
  assert.deepEqual(entries.get("b"), { id: "b", role: "dependent", auxiliary: false, hasValue: true });
});

test("delete() marks former dependents dirty so their next get() recomputes without the deleted cell", () => {
  // Mirrors ExpressionRow's params compute exactly: read an external cell
  // unconditionally (registering the edge even before it exists), use it
  // only if it has a real value, else fall back to a local cell.
  const g = new CellGraph();
  g.set("external", 5);
  g.set("local", 1);
  g.define("out", () => {
    const ext = g.get<number | undefined>("external");
    return g.hasValue("external") ? (ext as number) : g.get<number>("local");
  });
  assert.equal(g.get("out"), 5);
  g.delete("external");
  assert.equal(g.get("out"), 1, "recomputes and falls back to the local cell");
  // The recompute above rebuilt out's dependency edges -- a later write to
  // the fallback dependency must now reach it (before the delete() fix,
  // the edge never rebuilt, so this write was silently lost too).
  g.set("local", 42);
  assert.equal(g.get("out"), 42);
});

test("delete() notifies subscribers of former dependents (not just marks dirty)", () => {
  const g = new CellGraph();
  g.set("source", 1);
  g.define("derived", () => g.get<number>("source") * 2);
  g.get("derived");
  let notified = 0;
  g.subscribe("derived", () => notified++);
  g.delete("source");
  assert.ok(notified >= 1, "the dependent's subscriber fired on delete of its dependency");
});

test("delete() of a nonexistent or never-touched id is a harmless no-op", () => {
  const g = new CellGraph();
  g.delete("never-existed"); // must not throw
  g.set("a", 1);
  g.delete("a");
  g.delete("a"); // double delete is fine too
  assert.equal(g.hasValue("a"), false);
});

test("get() on a deleted id re-creates an empty record with 'never existed' semantics", () => {
  const g = new CellGraph();
  g.set("a", 7);
  g.delete("a");
  assert.equal(g.get("a"), undefined);
  assert.equal(g.hasValue("a"), false);
});

test("a compute that reads a sibling id before it's ever been set/defined sees undefined, then recomputes once that sibling is later defined (the mallory-graph#10 pattern)", () => {
  const g = new CellGraph();
  // Mirrors LinkedGraphPanes/Linked3DView's combinedDuration: defined before
  // either "pane" has mounted and defined its own timelineDuration cell.
  g.define("combined", () => {
    const a = g.get<number>("pane-a-duration");
    const b = g.get<number>("pane-b-duration");
    return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0);
  });
  // First read, before either pane exists: get() on a never-set id returns
  // undefined, not NaN -- the Number.isFinite guard is what keeps the
  // compute's own result a real number despite that.
  assert.equal(g.get("combined"), 0);

  // "pane-a" mounts and defines its own duration cell with a real value --
  // the dependency edge recorded during the first read above (get() on a
  // not-yet-existing id still registers the edge) means this define() call
  // marks "combined" dirty and notifies it, without "combined" having to be
  // re-read to pick up the change.
  let notified = 0;
  g.subscribe("combined", () => notified++);
  g.define("pane-a-duration", () => 5);
  assert.equal(notified, 1);
  assert.equal(g.get("combined"), 5);
});

// -----------------------------------------------------------------------
// Regression tests for github.com/johnhenry/mallory-graph issues #12-#16
// -----------------------------------------------------------------------

// #12 -- set() on a dependent cell leaks stale dependency edges
test("set() on a formerly-dependent cell actually empties its recorded dependency edges (not just stops acting on them)", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("b", () => g.get<number>("a") * 2);
  assert.equal(g.get("b"), 2); // b.dependencies = {a}, a.dependents = {b}

  g.set("b", 100); // b transitions dependent -> free

  // Reach into the private `cells` map directly -- this is the most direct
  // way to prove the edges are actually detached, not merely inert.
  const cells = (g as unknown as { cells: Map<string, { dependencies: Set<string>; dependents: Set<string> }> })
    .cells;
  assert.equal(cells.get("b")?.dependencies.size, 0, "b's own recorded dependencies are cleared");
  assert.equal(cells.get("a")?.dependents.has("b"), false, "a no longer records b as one of its dependents");
});

test("set() on a formerly-dependent cell stops receiving dirty propagation/notifications from its former dependencies", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("b", () => g.get<number>("a") * 2);
  assert.equal(g.get("b"), 2);

  g.set("b", 100);
  assert.equal(g.role("b"), "free");

  let notified = 0;
  g.subscribe("b", () => notified++);

  // "a" no longer has "b" as a dependent (per the previous test) -- a write
  // to "a" must not dirty or notify the now-free "b" at all.
  g.set("a", 999);
  assert.equal(notified, 0, "a write to the former dependency must not touch the now-free cell");
  assert.equal(g.get("b"), 100, "b's value is untouched by a's write");
});

// #13 -- structuralEqual treats any two zero-own-key objects as equal
test("structuralEqual distinguishes two distinct Dates instead of treating them as equal via zero-own-keys", () => {
  const a = new Date("2020-01-01T00:00:00Z");
  const b = new Date("2021-01-01T00:00:00Z");
  assert.equal(structuralEqual(a, b), false);
  assert.equal(structuralEqual(a, new Date(a.getTime())), true, "two Dates with the same time are still equal");
});

test("structuralEqual distinguishes two distinct Maps and Sets by content, not by their (zero) own enumerable keys", () => {
  assert.equal(structuralEqual(new Map([["x", 1]]), new Map([["x", 2]])), false);
  assert.equal(structuralEqual(new Map([["x", 1]]), new Map([["x", 1]])), true);
  assert.equal(structuralEqual(new Map([["x", 1]]), new Map([["y", 1]])), false, "different keys");
  assert.equal(structuralEqual(new Set([1, 2, 3]), new Set([1, 2, 4])), false);
  assert.equal(structuralEqual(new Set([1, 2, 3]), new Set([1, 2, 3])), true);
});

test("structuralEqual treats a Date/Map/Set as not equal to a plain object even with matching own keys", () => {
  assert.equal(structuralEqual(new Date(0), {}), false);
  assert.equal(structuralEqual(new Map(), {}), false);
});

test("structuralEqual does not infinite-loop (stack overflow) on a cyclic value", () => {
  const a: Record<string, unknown> = { n: 1 };
  a.self = a;
  const b: Record<string, unknown> = { n: 1 };
  b.self = b;
  assert.doesNotThrow(() => structuralEqual(a, b));
  assert.equal(structuralEqual(a, b), true, "structurally identical cyclic shapes compare equal");

  const c: Record<string, unknown> = { n: 2 };
  c.self = c;
  assert.equal(structuralEqual(a, c), false, "a genuine difference outside the cycle is still detected");
});

test("a cell holding a Date now correctly bumps version/notifies on a real Date change, instead of the change being silently swallowed", () => {
  const g = new CellGraph();
  g.set("d", new Date("2020-01-01T00:00:00Z"));
  const v1 = g.getVersion("d");
  let notified = 0;
  g.subscribe("d", () => notified++);

  g.set("d", new Date("2021-01-01T00:00:00Z")); // genuinely different Date
  assert.ok(g.getVersion("d") > v1, "version bumps for a real Date change");
  assert.equal(notified, 1);
});

// #14 -- failing computes rethrow on every get() with no error caching
test("a throwing compute caches its error -- repeated get() calls rethrow without re-running the compute", () => {
  const g = new CellGraph();
  let calls = 0;
  g.define("bad", () => {
    calls++;
    throw new Error("boom");
  });
  assert.throws(() => g.get("bad"), /boom/);
  assert.equal(calls, 1);
  assert.throws(() => g.get("bad"), /boom/);
  assert.throws(() => g.get("bad"), /boom/);
  assert.equal(calls, 1, "the compute must not re-run on subsequent get() calls -- the cached error is rethrown");
});

test("a cached compute error is invalidated once a real dependency change makes the cell dirty again", () => {
  const g = new CellGraph();
  g.set("shouldFail", true);
  let calls = 0;
  g.define("maybeFails", () => {
    calls++;
    if (g.get<boolean>("shouldFail")) throw new Error("nope");
    return 42;
  });
  assert.throws(() => g.get("maybeFails"));
  assert.equal(calls, 1);
  assert.throws(() => g.get("maybeFails"));
  assert.equal(calls, 1, "still cached -- no retry yet");

  g.set("shouldFail", false); // dirties "maybeFails" via the normal propagateDirty cascade
  assert.equal(g.get("maybeFails"), 42, "the next get() after a real dependency change retries the compute");
  assert.equal(calls, 2);
});

test("set()ing a formerly-erroring dependent cell to free clears its cached error", () => {
  const g = new CellGraph();
  g.define("bad", () => {
    throw new Error("boom");
  });
  assert.throws(() => g.get("bad"));
  g.set("bad", 5);
  assert.equal(g.get("bad"), 5, "no stale cached error survives the dependent -> free transition");
});

// #15 -- define() bumps the version unconditionally
test("define() does not bump version/notify when redefining with a compute that yields a structurally-identical result", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("double", () => g.get<number>("a") * 2);
  assert.equal(g.get("double"), 2);
  const versionAfterFirst = g.getVersion("double");

  let notified = 0;
  g.subscribe("double", () => notified++);

  // Redefine with a different compute fn that happens to produce the same
  // value (e.g. a component remount or a config reapply) -- must not bump
  // version or notify at all.
  g.define("double", () => 1 + 1);
  assert.equal(notified, 0, "the redefine resolved to no real change -- no notification");
  assert.equal(g.get("double"), 2);
  assert.equal(notified, 0, "reading again afterwards must not notify a second time either");
  assert.equal(
    g.getVersion("double"),
    versionAfterFirst,
    "version is unchanged since the recomputed value is structurally identical",
  );
});

test("define() bumps version/notifies SYNCHRONOUSLY (not deferred to some later get()) when a redefine genuinely changes the value", () => {
  // This is the guarantee that actually matters for the live app:
  // useSyncExternalStore's re-render is scheduled by the subscribe
  // callback firing (i.e. emit()), not by some future get() call that
  // nothing guarantees will ever happen. A fix that deferred notification
  // to the next get() would leave a subscribed component's UI stale
  // indefinitely whenever nothing else happens to re-render it.
  const g = new CellGraph();
  g.set("a", 1);
  g.define("double", () => g.get<number>("a") * 2);
  assert.equal(g.get("double"), 2);
  const versionAfterFirst = g.getVersion("double");

  let notified = 0;
  g.subscribe("double", () => notified++);

  g.define("double", () => 100); // genuinely different result
  assert.equal(notified, 1, "notified synchronously by define() itself -- no intervening get() call");
  assert.ok(g.getVersion("double") > versionAfterFirst, "version already bumped synchronously too");
  assert.equal(g.get("double"), 100, "and the cached value already reflects the new result");
  assert.equal(notified, 1, "reading it afterwards must not notify a second time");
});

test("define() redefining with a throwing compute does not throw synchronously, and does not notify (error is cached for the next get(), per #14)", () => {
  const g = new CellGraph();
  g.define("risky", () => 1);
  assert.equal(g.get("risky"), 1);

  let notified = 0;
  g.subscribe("risky", () => notified++);

  assert.doesNotThrow(() => {
    g.define("risky", () => {
      throw new Error("boom");
    });
  });
  assert.equal(notified, 0, "a failed redefine has no real value change to notify about");
  assert.throws(() => g.get("risky"), /boom/);
});

test("define() still eagerly notifies dependents on a first-ever definition (no prior value to compare against)", () => {
  // A first define() has no cached value to defer against -- hasValue flips
  // false -> true unconditionally, so the existing eager-cascade behavior
  // (relied on by the mallory-graph#10-pattern test above) must be
  // untouched by the #15 fix.
  const g = new CellGraph();
  let notified = 0;
  g.subscribe("fresh", () => notified++);
  g.define("fresh", () => 1);
  assert.equal(notified, 1);
});

// #16 -- listener and record cleanup gaps on delete
test("subscribe(): the last unsubscribe removes the (now-empty) listener Set for a cell, not just the listener itself", () => {
  const g = new CellGraph();
  const unsub1 = g.subscribe("x", () => {});
  const unsub2 = g.subscribe("x", () => {});

  const listeners = (g as unknown as { listeners: Map<string, Set<unknown>> }).listeners;
  assert.equal(listeners.has("x"), true);
  unsub1();
  assert.equal(listeners.has("x"), true, "one listener remains -- the Set itself must still be present");
  unsub2();
  assert.equal(
    listeners.has("x"),
    false,
    "the last unsubscribe must remove the now-empty Set entirely, not leave an empty one behind",
  );
});

test("subscribe()'s ensure()-created cell record does not outlive its subscribers when the cell was never actually set/defined", () => {
  const g = new CellGraph();
  assert.equal(g.has("phantom"), false);
  const unsub = g.subscribe("phantom", () => {});
  assert.equal(g.has("phantom"), true, "subscribe() materializes an empty record via ensure(), same as get() does");
  unsub();
  assert.equal(
    g.has("phantom"),
    false,
    "with no subscribers left and no real value/definition, the phantom record is cleaned up instead of leaking forever",
  );
});

test("a genuinely live cell (has a real value) is NOT removed just because its subscribers all go away", () => {
  const g = new CellGraph();
  g.set("real", 1);
  const unsub = g.subscribe("real", () => {});
  unsub();
  assert.equal(g.has("real"), true, "a cell with a real value must survive its subscribers going away");
  assert.equal(g.get("real"), 1, "only explicit delete() removes a live cell");
});

test("a cell still participating in the dependency graph (has a dependent) is NOT removed when its own subscribers go away", () => {
  const g = new CellGraph();
  g.define("derived", () => g.get<number | undefined>("dep"));
  g.get("derived"); // registers "derived" as a dependent of "dep", materializing dep's empty record
  const unsub = g.subscribe("dep", () => {});
  unsub();
  assert.equal(g.has("dep"), true, '"dep" still has a dependent ("derived") -- must not be silently removed out from under it');
});

test("many dynamically created/destroyed subscription-only cells do not accumulate unboundedly (the ExpressionRow per-row-cell pattern)", () => {
  const g = new CellGraph();
  for (let i = 0; i < 50; i++) {
    const id = `row-${i}`;
    const unsub = g.subscribe(id, () => {});
    unsub();
  }
  const cells = (g as unknown as { cells: Map<string, unknown> }).cells;
  const listeners = (g as unknown as { listeners: Map<string, unknown> }).listeners;
  assert.equal(cells.size, 0, "no phantom cell records survive their subscribers going away");
  assert.equal(listeners.size, 0, "no empty listener Sets survive their subscribers going away");
});

test("subscribeWrites: fires on a real set() with the id and new value", () => {
  const g = new CellGraph();
  const writes: Array<{ id: string; value: unknown }> = [];
  g.subscribeWrites((id, value) => writes.push({ id, value }));
  g.set("a", 1);
  g.set("a", 2);
  assert.deepEqual(writes, [
    { id: "a", value: 1 },
    { id: "a", value: 2 },
  ]);
});

test("subscribeWrites: does NOT fire for a no-op set() (structurally-identical value)", () => {
  const g = new CellGraph();
  const writes: unknown[] = [];
  g.set("a", { x: 1 });
  g.subscribeWrites((id, value) => writes.push({ id, value }));
  g.set("a", { x: 1 }); // structurally equal to the existing value -- a no-op
  assert.deepEqual(writes, []);
});

test("subscribeWrites: does NOT fire for a define()-driven recompute -- only raw set() calls, matching the live-collaboration use case (issue #47) of broadcasting user-initiated writes, not every derived cascade", () => {
  const g = new CellGraph();
  const writes: Array<{ id: string; value: unknown }> = [];
  g.set("base", 1);
  g.define("derived", () => g.get<number>("base") * 2);
  g.subscribeWrites((id, value) => writes.push({ id, value }));
  g.set("base", 5); // triggers "derived" to recompute on next get(), but that's not a set() call
  g.get("derived");
  assert.deepEqual(writes, [{ id: "base", value: 5 }], "only the raw set() on \"base\" should appear, never \"derived\"");
});

test("subscribeWrites: the returned unsubscribe function stops future notifications", () => {
  const g = new CellGraph();
  const writes: unknown[] = [];
  const unsub = g.subscribeWrites((id, value) => writes.push({ id, value }));
  g.set("a", 1);
  unsub();
  g.set("a", 2);
  assert.deepEqual(writes, [{ id: "a", value: 1 }]);
});

// -----------------------------------------------------------------------
// Regression tests for github.com/johnhenry/mallory-graph issue #234:
// subscribeAll over-firing (bug 1) and reentrant-write swallowing (bug 2).
// -----------------------------------------------------------------------

test("subscribeAll: a single set() on the root of a diamond dependency graph fires global listeners exactly once, not once per cascaded dependent (#234 bug 1)", () => {
  const g = new CellGraph();
  g.set("root", 1);
  g.define("left", () => g.get<number>("root") + 1);
  g.define("right", () => g.get<number>("root") + 2);
  g.define("bottom", () => g.get<number>("left") + g.get<number>("right"));
  // Prime everything so it's clean/cached before the edit under test.
  g.get("left");
  g.get("right");
  g.get("bottom");

  let calls = 0;
  g.subscribeAll(() => calls++);

  g.set("root", 2); // one logical write, cascades dirty through left, right, bottom
  assert.equal(calls, 1, "one subscribeAll notification for the whole cascade, not one per dirtied cell");

  // A second logical write is its own, separate notification.
  g.set("root", 3);
  assert.equal(calls, 2);
});

test("subscribeAll: a define() redefine that cascades to dependents also fires global listeners exactly once (#234 bug 1)", () => {
  const g = new CellGraph();
  g.set("a", 1);
  g.define("b", () => g.get<number>("a") * 2);
  g.define("c", () => g.get<number>("b") + 1);
  g.get("b");
  g.get("c");

  let calls = 0;
  g.subscribeAll(() => calls++);

  g.define("b", () => g.get<number>("a") * 10); // redefine -- recomputes b synchronously, cascades to c
  assert.equal(calls, 1);
});

test("subscribeAll: delete() cascading dirty to multiple former dependents still fires global listeners exactly once (#234 bug 1)", () => {
  const g = new CellGraph();
  g.set("shared", 1);
  g.define("readerA", () => g.get<number>("shared") + 1);
  g.define("readerB", () => g.get<number>("shared") + 2);
  g.get("readerA");
  g.get("readerB");

  let calls = 0;
  g.subscribeAll(() => calls++);

  g.delete("shared"); // dirties both readerA and readerB in one logical write
  assert.equal(calls, 1);
});

test("subscribeAll: a reentrant set() on a DIFFERENT cell from inside a global listener is not swallowed -- both changes are eventually delivered (#234 bug 2)", () => {
  const g = new CellGraph();
  g.set("x", 1);
  g.set("y", 1);

  const seen: string[] = [];
  let reentered = false;
  g.subscribeAll(() => {
    seen.push(`fired (x=${g.get("x")}, y=${g.get("y")})`);
    if (!reentered) {
      reentered = true;
      g.set("y", 2); // distinct cell, synchronously, from inside the global listener
    }
  });

  g.set("x", 2);

  // Before the fix, the reentrant write to "y" was silently dropped because
  // the single shared `notifyingGlobal` boolean blocked ANY global
  // notification while one was already in flight for "x" -- so only 1 call
  // was ever recorded despite 2 real, distinct cell changes.
  assert.equal(seen.length, 2, "both the original write and the reentrant write to a different cell notify");
  assert.equal(g.get("y"), 2, "the reentrant write itself was never lost -- only its notification was");
});

test("subscribeAll: a reentrant set() on the SAME cell from inside a global listener does not recurse unboundedly (still bounded/sane) (#234 bug 2 edge case)", () => {
  const g = new CellGraph();
  g.set("x", 1);

  let calls = 0;
  g.subscribeAll(() => {
    calls++;
    if (g.get<number>("x") < 3) g.set("x", (g.get<number>("x") as number) + 1);
  });

  g.set("x", 2); // kicks off a same-cell reentrant chain: 2 -> 3, each write its own notification
  assert.equal(g.get("x"), 3);
  assert.equal(calls, 2, "one notification per real distinct value the cell actually passed through (2 -> 3)");
});
