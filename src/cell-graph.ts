/**
 * VENDORED from johnhenry/mallory-graph `src/lib/cell-graph.ts` (2026-08-19,
 * at mallory-graph commit 2bd7dd2) per docs/design.md §6: this copy is
 * frozen except for mallory-grapher's own needs; the end state is CellGraph
 * moving into mallory-math, at which point this file is deleted and both
 * consumers import it from there. Drift from mallory-graph's copy during
 * the interim is expected and acceptable.
 *
 * CellGraph — a reactive, pull-based dependency graph. Cells hold typed
 * values (numbers, points, curves, whatever) rather than flattened
 * primitives; a derived cell's `compute` reads other cells via `graph.get`,
 * and the graph records the resulting edges automatically (no manual tag
 * declarations, unlike mcp-query's cache).
 *
 * Writes (`set`) mark transitive dependents dirty and bump their version
 * counters immediately — cheap, no recompute. Recomputation happens lazily,
 * the next time a dirty cell is `get`, and a structural-equality check skips
 * the version bump (and further propagation) when a recompute produces a
 * value that's deep-equal to what was already cached, so unaffected
 * downstream consumers don't re-render.
 */

type Listener = () => void;
type ComputeFn<T> = () => T;

interface CellRecord<T = unknown> {
  value: T | undefined;
  hasValue: boolean;
  version: number;
  dirty: boolean;
  compute?: ComputeFn<T>;
  dependencies: Set<string>;
  dependents: Set<string>;
  auxiliary: boolean;
  /**
   * Set when `compute` most recently threw, so a failing (possibly
   * expensive) compute doesn't get re-run on every subsequent `get()` --
   * see {@link CellGraph.get} and {@link CellGraph.recomputeAndEmit}.
   * Cleared by anything that also clears `dirty`'s stale-value equivalent:
   * a fresh `set()`/successful recompute.
   */
  hasError: boolean;
  error?: unknown;
}

export type CellRole = "free" | "dependent" | "unknown";

export class CircularDependencyError extends Error {
  constructor(path: string[]) {
    super(`Circular dependency detected in cell graph: ${path.join(" -> ")}`);
    this.name = "CircularDependencyError";
  }
}

export class CellGraph {
  private cells = new Map<string, CellRecord>();
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<Listener>();
  private writeListeners = new Set<(id: string, value: unknown) => void>();
  private stack: string[] = [];
  private emitting = new Set<string>();
  /**
   * Nesting depth of the current "logical write" -- incremented around the
   * body of every top-level mutating entry point ({@link set}, {@link
   * define}, {@link delete}) and decremented in a `finally` when it returns.
   * A single `set()` on a root of a diamond-shaped dependency graph cascades
   * through `propagateDirty` and calls `emit()` once per cell it reaches
   * (root, then each newly-dirtied dependent) -- all of those belong to the
   * SAME logical write and must produce exactly one `subscribeAll`
   * notification, not one per cell. While this is above zero, a request to
   * notify global listeners (see {@link scheduleGlobalNotify}) is deferred
   * instead of firing immediately; it only actually fires once depth
   * unwinds back to zero, i.e. once the outermost `set`/`define`/`delete`
   * call (including any cells it transitively dirtied) has fully finished.
   */
  private globalNotifyDepth = 0;
  /** Set by {@link scheduleGlobalNotify} while `globalNotifyDepth > 0`, so the deferred notification isn't lost once depth returns to zero. */
  private globalNotifyPending = false;
  /**
   * Guards the global-listener-invocation loop itself against being
   * re-entered while it's already running -- e.g. a global listener that
   * synchronously calls `set()` on a DIFFERENT cell from inside its own
   * callback. Unlike the shared boolean this replaces, a reentrant request
   * that arrives while this is `true` is NOT dropped: it re-arms {@link
   * globalNotifyPending}, which is drained (fired again) right after the
   * in-progress loop finishes -- see {@link flushGlobalNotify}. This is what
   * keeps a reentrant write to a different cell from being silently
   * swallowed (issue #234), while still bounding recursion depth to one
   * extra level per reentrant write, the same way `emitting` bounds it for
   * same-id reentrancy on local listeners.
   */
  private notifyingGlobalListeners = false;

  /**
   * Write a raw source-of-truth value (e.g. a slider drag or text input).
   * Structurally, a cell written via `set` (no `compute` fn) is what makes
   * it "free" -- see {@link role}.
   *
   * @param options.auxiliary Marks this cell hidden-by-default in an
   * Algebra-view-style listing (see {@link list}) -- e.g. an internal
   * sampling parameter that isn't itself meaningful to show the user,
   * distinct from a top-level named object. Only applied when the cell
   * doesn't already exist, or is transitioning from a compute-backed
   * (dependent) cell to a free one; an existing free cell's auxiliary flag
   * is left as originally set.
   */
  set<T>(id: string, value: T, options?: { auxiliary?: boolean }): void {
    this.runBatched(() => {
      const cell = this.ensure<T>(id);
      const wasCompute = cell.compute !== undefined;
      cell.compute = undefined;
      if (wasCompute) {
        // This cell is transitioning from dependent (had a compute fn) to
        // free -- detach its recorded dependency edges the same way
        // recomputeAndEmit() and delete() already do, so former upstream
        // cells stop spuriously dirtying/emitting a cell they no longer feed
        // into.
        for (const depId of cell.dependencies) this.cells.get(depId)?.dependents.delete(id);
        cell.dependencies = new Set();
      }
      if (options?.auxiliary !== undefined && (wasCompute || !cell.hasValue)) cell.auxiliary = options.auxiliary;
      cell.hasError = false;
      cell.error = undefined;
      const unchanged = cell.hasValue && structuralEqual(cell.value, value);
      cell.dirty = false;
      if (unchanged) return;
      // Only replace the cached reference on a real change, so a write that's
      // structurally equal to the old value never disturbs downstream identity.
      cell.value = value;
      cell.hasValue = true;
      cell.version++;
      this.emitWrite(id, value);
      this.emit(id);
      this.propagateDirty(id);
    });
  }

  /**
   * Subscribe to raw `set()` writes -- id plus the new value -- across
   * every cell in the graph (issue #47's live-collaboration groundwork).
   * Deliberately narrower than `subscribeAll`: it fires ONLY for an actual
   * `set()` call with a real (structurally-different) value, never for a
   * `define()`-driven recompute cascade. That's the exact shape a
   * broadcast-to-other-peers use case needs -- each peer re-derives its
   * own dependent cells locally once a base write arrives over the wire
   * and gets applied via `set()` there too, so only the raw user-initiated
   * writes need to cross the network, not every recomputed cell downstream
   * of them.
   */
  subscribeWrites(fn: (id: string, value: unknown) => void): () => void {
    this.writeListeners.add(fn);
    return () => this.writeListeners.delete(fn);
  }

  private emitWrite(id: string, value: unknown): void {
    for (const fn of this.writeListeners) fn(id, value);
  }

  /**
   * Define (or redefine) a derived cell computed from other cells.
   * Structurally, a cell written via `define` (has a `compute` fn) is what
   * makes it "dependent" -- see {@link role}.
   *
   * @param options.auxiliary See {@link set}'s equivalent option; applied
   * the same way (only on first definition, or a transition from free to
   * dependent).
   */
  define<T>(id: string, compute: ComputeFn<T>, options?: { auxiliary?: boolean }): void {
    this.runBatched(() => this.defineImpl(id, compute, options));
  }

  private defineImpl<T>(id: string, compute: ComputeFn<T>, options?: { auxiliary?: boolean }): void {
    const cell = this.ensure<T>(id);
    const wasFree = cell.compute === undefined && cell.hasValue;
    const isRedefine = cell.hasValue;
    if (options?.auxiliary !== undefined && (wasFree || cell.compute === undefined)) cell.auxiliary = options.auxiliary;
    cell.compute = compute;
    cell.dirty = true;
    cell.hasError = false;
    cell.error = undefined;
    // A cell being defined for the first time (no prior value) is
    // guaranteed to change once computed -- hasValue flips false -> true
    // regardless of what the compute returns -- so it's safe to eagerly
    // bump its version and notify its own subscribers now, same as before,
    // with no need to actually run the compute early.
    //
    // A cell that already has a value is being *redefined*: unlike set(),
    // define() doesn't have the new value in hand to structuralEqual-check
    // synchronously -- only a function. The fix for #15 is NOT "defer the
    // notification to some future get()": nothing guarantees a future
    // get() ever happens. useSyncExternalStore's subscribe callback (see
    // use-cell.ts) is what schedules a component's next render in the
    // first place, and that callback only fires from emit() -- so an
    // un-emitted genuine change would sit invisible until something
    // UNRELATED happens to re-render the same subscribed component. That's
    // a missed update, strictly worse than the unwanted-churn bug #15 set
    // out to fix. Instead, resolve it the same way set() does: eagerly,
    // synchronously, right here -- via recomputeAndEmit, which already
    // implements exactly the "recompute, structuralEqual-gate the version
    // bump/emit" logic this needs (and already detaches/rebuilds
    // `dependencies` correctly as part of that). A throwing new compute is
    // swallowed here (recomputeAndEmit already cached it on the cell via
    // #14's hasError/error fields before rethrowing) so define() keeps its
    // pre-existing never-throws-synchronously contract; the cached error
    // surfaces through the normal get()-throws path on the next read.
    if (isRedefine) {
      try {
        this.recomputeAndEmit(id, cell);
      } catch {
        // Cached on the cell already; surfaced via get(), not here.
      }
    } else {
      cell.version++;
      this.emit(id);
    }
    this.propagateDirty(id);
  }

  /**
   * Whether `id` is "free" (writable directly via `set`, no `compute` fn --
   * e.g. a slider or text input), "dependent" (computed via `define` from
   * other cells), or "unknown" (`id` has never been `set`/`define`d, only
   * read, or doesn't exist at all).
   */
  role(id: string): CellRole {
    const cell = this.cells.get(id);
    if (!cell || !cell.hasValue) return "unknown";
    return cell.compute ? "dependent" : "free";
  }

  /** Whether `id` was marked `auxiliary` (hidden-by-default in an Algebra-view-style listing) -- see {@link set}/{@link define}. */
  isAuxiliary(id: string): boolean {
    return this.cells.get(id)?.auxiliary ?? false;
  }

  /**
   * Every cell currently in the graph, with its role and auxiliary flag --
   * the basis for an Algebra-view-style listing (GeoGebra's free/dependent/
   * auxiliary object model). Includes cells with no value yet (role
   * "unknown") since a caller may still want to know such an id exists
   * (e.g. was read but never written).
   */
  list(): Array<{ id: string; role: CellRole; auxiliary: boolean; hasValue: boolean }> {
    return [...this.cells.entries()].map(([id, cell]) => ({
      id,
      role: this.role(id),
      auxiliary: cell.auxiliary,
      hasValue: cell.hasValue,
    }));
  }

  /** Read a cell's current value, recomputing if stale. Auto-tracks dependency edges. */
  get<T>(id: string): T {
    const cell = this.ensure<T>(id);

    // The cell currently being computed (if any) reads `id` — record the edge.
    const caller = this.stack.at(-1);
    if (caller !== undefined) {
      this.cells.get(caller)?.dependencies.add(id);
      cell.dependents.add(caller);
    }

    if (cell.dirty && cell.compute) {
      if (this.stack.includes(id)) throw new CircularDependencyError([...this.stack, id]);

      this.recomputeAndEmit(id, cell);
    }

    // A cached compute failure (see recomputeAndEmit's catch) is rethrown
    // here on every subsequent get() -- without re-running the compute --
    // until the same conditions that would invalidate a cached value (a
    // fresh set()/define(), or a real upstream change marking this cell
    // dirty again) clear it.
    if (cell.hasError) throw cell.error;

    return cell.value as T;
  }

  private recomputeAndEmit<T>(id: string, cell: CellRecord<T>): void {
    // Dependencies may differ between evaluations (e.g. a conditional
    // expression) — detach from the old set before recomputing fresh.
    for (const depId of cell.dependencies) this.cells.get(depId)?.dependents.delete(id);
    cell.dependencies = new Set();

    this.stack.push(id);
    let next: T;
    try {
      next = cell.compute!() as T;
    } catch (err) {
      // Cache the failure so a subsequent get() (another render pass, a
      // sibling compute reading this cell again, etc.) rethrows the same
      // cached error instead of re-running a compute that's going to fail
      // identically. `dirty` is still cleared here: this recompute attempt
      // did happen and did resolve (to a failure), and staying dirty would
      // otherwise force every future get() back through the compute anyway.
      cell.dirty = false;
      cell.hasError = true;
      cell.error = err;
      throw err;
    } finally {
      this.stack.pop();
    }

    cell.dirty = false;
    cell.hasError = false;
    cell.error = undefined;

    const unchanged = cell.hasValue && structuralEqual(cell.value, next);

    if (!unchanged) {
      // Reassign only on a real change, preserving the old reference on a
      // no-op recompute — this is what lets a downstream Object.is check
      // (e.g. React's useSyncExternalStore, or React.memo) bail out.
      cell.value = next;
      cell.hasValue = true;
      cell.version++;
      this.emit(id);
    }
  }

  /** The value useSyncExternalStore observes for this cell. */
  getVersion(id: string): number {
    return this.cells.get(id)?.version ?? 0;
  }

  /** Subscribe to changes on one cell. Returns an unsubscribe function. */
  subscribe(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    this.ensure(id);
    return () => {
      set.delete(fn);
      if (set.size !== 0) return;
      // Last subscriber for this id gone -- drop the now-empty Set instead
      // of leaving it behind forever (an id that's subscribed-to-then-
      // unsubscribed-from many times over a session, e.g. a dynamically
      // created/destroyed notebook row, would otherwise accumulate one dead
      // empty Set per id in `listeners`).
      this.listeners.delete(id);
      // If this cell was never actually given a value or a compute (i.e.
      // the only reason it exists in `cells` at all is the ensure() call a
      // few lines up) and nothing else in the graph references it (no
      // dependents, no recorded dependencies), there's nothing left to
      // justify keeping that phantom record around either -- clean it up
      // too. A genuinely "live" cell (has a real value, is define()d, or
      // participates in the dependency graph as someone's dependency/
      // dependent) is untouched here; only explicit delete() removes those,
      // per its own documented semantics -- this is deliberately narrower
      // than delete() and never fires the "former dependents" notification
      // delete() does, since there's no real removal of live state here.
      const cell = this.cells.get(id);
      if (
        cell &&
        !cell.hasValue &&
        cell.compute === undefined &&
        cell.dependents.size === 0 &&
        cell.dependencies.size === 0
      ) {
        this.cells.delete(id);
      }
    };
  }

  /** Subscribe to changes on any cell (e.g. to drive a canvas render loop). */
  subscribeAll(fn: Listener): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  /**
   * Subscribe to changes on a fixed, known set of specific cells -- e.g.
   * every cell a serialized URL fragment reads. Narrower than
   * `subscribeAll`: `fn` fires only for a write on one of `ids`, not for
   * literally any cell in the graph (issue #235 -- several panels' URL-sync
   * effects used `subscribeAll` for exactly this "a handful of specific
   * cells" shape, so they also fired on unrelated high-frequency writes
   * elsewhere in the same graph -- an RAF-driven playback clock, a live
   * drag preview, a per-epoch training metric -- that the listener's own
   * output never actually depended on). Just sugar over one `subscribe`
   * call per id; not appropriate when the relevant id set is itself dynamic
   * (e.g. "every currently-visible row's cells", where the row list can
   * grow/shrink) -- that shape still needs `subscribeAll` (ideally
   * debounced) or per-id `subscribe` calls re-issued as the id set changes.
   */
  subscribeMany(ids: string[], fn: Listener): () => void {
    const unsubscribes = ids.map((id) => this.subscribe(id, fn));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  has(id: string): boolean {
    return this.cells.has(id);
  }

  /**
   * Whether `id` has a real value yet, as opposed to merely existing as an
   * empty record (`has()` returns true for a cell the instant anything reads
   * it via `get`, even before it's ever been `set` or `define`d -- not a
   * reliable "should I seed this?" check from a post-render effect that runs
   * after a sibling compute has already read-and-thus-created it).
   */
  hasValue(id: string): boolean {
    return this.cells.get(id)?.hasValue ?? false;
  }

  /**
   * Remove a cell entirely. Former *dependents* are marked dirty and
   * notified (same as a `set()` would), so a compute that read the deleted
   * cell re-runs and can fall back to whatever "this cell doesn't exist"
   * means for it -- without this, a dependent kept its stale cached value
   * forever, AND (because its dependency edges only rebuild during a
   * recompute that never came) writes to its other dependencies stopped
   * reaching it too. The notification happens *after* the cell is gone, so
   * the reentrant recompute a listener may trigger sees the post-delete
   * world: a `get()` on the deleted id re-creates an empty record
   * (`hasValue: false`), exactly the "never existed" semantics callers
   * like ExpressionRow's params compute already handle.
   */
  delete(id: string): void {
    this.runBatched(() => {
      const cell = this.cells.get(id);
      if (!cell) return;
      const formerDependents = [...cell.dependents];
      for (const depId of cell.dependencies) this.cells.get(depId)?.dependents.delete(id);
      for (const depId of cell.dependents) this.cells.get(depId)?.dependencies.delete(id);
      this.cells.delete(id);
      this.listeners.delete(id);
      for (const depId of formerDependents) {
        const dep = this.cells.get(depId);
        if (!dep || dep.dirty) continue;
        dep.dirty = true;
        this.emit(depId);
        this.propagateDirty(depId);
      }
    });
  }

  private ensure<T>(id: string): CellRecord<T> {
    let cell = this.cells.get(id) as CellRecord<T> | undefined;
    if (!cell) {
      cell = {
        value: undefined,
        hasValue: false,
        version: 0,
        dirty: true,
        dependencies: new Set(),
        dependents: new Set(),
        auxiliary: false,
        hasError: false,
        error: undefined,
      };
      this.cells.set(id, cell);
    }
    return cell;
  }

  private propagateDirty(id: string): void {
    const cell = this.cells.get(id);
    if (!cell) return;
    // Snapshot before iterating: `emit` below can synchronously trigger a
    // nested recompute (via useSyncExternalStore's listener) that detaches
    // and re-adds an entry to this very `dependents` set. Iterating the live
    // Set would then revisit that re-added entry within the same pass,
    // looping forever between cells that share this dependency.
    for (const depId of [...cell.dependents]) {
      const dep = this.cells.get(depId);
      if (!dep || dep.dirty) continue; // already dirty -> already propagated past this point
      dep.dirty = true;
      // Notify listeners so a subscriber (e.g. useSyncExternalStore) re-reads
      // via get(), which lazily recomputes. No version bump here — that only
      // happens in get()/set() once a recompute confirms a real value change,
      // which is what lets an unaffected downstream branch skip its redraw.
      this.emit(depId);
      this.propagateDirty(depId);
    }
  }

  /**
   * Notify `id`'s listeners that it may have changed. Guarded against
   * reentrancy per-id: a `useSyncExternalStore` listener synchronously
   * calls `getSnapshot` (React's own tearing check) as soon as it's
   * notified, which re-enters `get()` and, on a real recompute, calls back
   * into `emit(id)` for the very same id before this call has returned.
   * Without the guard that nested call re-invokes every listener again
   * (including the one currently on the stack), which re-triggers the same
   * reentrant read, forever -- an unbounded synchronous storm that pins the
   * CPU and eventually OOMs the JS heap. It's always safe to drop the
   * nested notification: any consumer notified mid-flight still reads the
   * freshest value the next time it calls `get()`, so no update is lost by
   * collapsing repeat notifications for the same id into one.
   *
   * The global (`subscribeAll`) notification is requested here but not
   * fired directly -- see {@link scheduleGlobalNotify}: a single logical
   * write (e.g. one `set()` on the root of a diamond-shaped dependency
   * graph) calls `emit()` once per cell it transitively dirties, but must
   * still only produce ONE `subscribeAll` notification (issue #234).
   */
  private emit(id: string): void {
    if (this.emitting.has(id)) return;
    this.emitting.add(id);
    try {
      for (const fn of this.listeners.get(id) ?? []) fn();
      this.scheduleGlobalNotify();
    } finally {
      this.emitting.delete(id);
    }
  }

  /**
   * Run `fn` as one "logical write" for the purposes of global-listener
   * batching -- see {@link globalNotifyDepth}. Reentrant calls (e.g. a
   * `subscribe()` listener triggered mid-cascade that synchronously calls
   * `get()`, which recomputes and dirties further cells) nest transparently:
   * only the outermost call's `finally` can bring the depth back to zero and
   * trigger the deferred flush.
   */
  private runBatched<T>(fn: () => T): T {
    this.globalNotifyDepth++;
    try {
      return fn();
    } finally {
      this.globalNotifyDepth--;
      if (this.globalNotifyDepth === 0 && this.globalNotifyPending) this.flushGlobalNotify();
    }
  }

  /**
   * Request a `subscribeAll` notification. While a logical write is still
   * in progress ({@link globalNotifyDepth} > 0), the request is only
   * recorded ({@link globalNotifyPending}) -- {@link runBatched} flushes it
   * once that write (including everything it cascaded into) fully unwinds.
   * Outside of any write (e.g. a standalone `get()` that lazily recomputes a
   * dirty cell with no `set`/`define`/`delete` on the stack), there's no
   * outer call to flush later, so it fires immediately.
   */
  private scheduleGlobalNotify(): void {
    this.globalNotifyPending = true;
    if (this.globalNotifyDepth === 0) this.flushGlobalNotify();
  }

  /**
   * Actually invoke every `subscribeAll` listener, once, for the batch of
   * cell changes accumulated since the last flush.
   *
   * Guarded against reentering the listener-invocation loop itself --
   * `notifyingGlobalListeners`, scoped to "is a global-listener loop
   * currently on the stack" rather than per-cell-id, because by this point
   * the notification is no longer about any single cell; it's "this batch
   * of writes changed something." A listener that synchronously starts a
   * NEW logical write (e.g. `set()` on a different cell) re-arms {@link
   * globalNotifyPending} instead of recursing into a second, nested
   * invocation of every listener -- that pending flag is drained in the
   * `while` loop below once the in-progress loop returns, so that second
   * write's notification still fires (once), it's just deferred to right
   * after the first finishes rather than dropped. This is what fixes issue
   * #234's bug 2: the previous shared `notifyingGlobal` boolean guard
   * skipped (silently discarded) exactly this case instead of deferring it.
   */
  private flushGlobalNotify(): void {
    if (this.notifyingGlobalListeners) return; // already mid-loop; that loop's own drain (below) will pick this up
    this.notifyingGlobalListeners = true;
    try {
      while (this.globalNotifyPending) {
        this.globalNotifyPending = false;
        for (const fn of this.globalListeners) fn();
      }
    } finally {
      this.notifyingGlobalListeners = false;
    }
  }
}

/** Deep structural equality, used to skip redraws when a recompute is a no-op. */
export function structuralEqual(a: unknown, b: unknown): boolean {
  return structuralEqualInner(a, b, []);
}

// `seen` is the stack of (a, b) pairs currently being compared by an
// enclosing call on the stack -- used only as a cycle guard, see below.
function structuralEqualInner(a: unknown, b: unknown, seen: Array<[object, object]>): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  // Cycle guard: if this exact (a, b) pair is already being compared by an
  // enclosing (ancestor) call on the stack, it's a cycle -- stop recursing
  // and treat it as equal here rather than looping forever. Any genuine
  // difference elsewhere in the structure is still found by the other,
  // non-cyclic branches of the comparison; this only prevents the recursion
  // itself from being unbounded.
  for (const [sa, sb] of seen) {
    if (sa === a && sb === b) return true;
  }

  // Two objects of genuinely different types (Date vs plain object, Map vs
  // Set, etc.) are never equal, regardless of their own-key shape below.
  const aTag = Object.prototype.toString.call(a);
  const bTag = Object.prototype.toString.call(b);
  if (aTag !== bTag) return false;

  seen = [...seen, [a, b]];

  if (a instanceof Date) return a.getTime() === (b as Date).getTime();

  if (a instanceof Map) {
    const bm = b as Map<unknown, unknown>;
    if (a.size !== bm.size) return false;
    for (const [k, v] of a) {
      if (!bm.has(k) || !structuralEqualInner(v, bm.get(k), seen)) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    // Set membership is by identity/SameValueZero, matching the Set's own
    // semantics (not a structural comparison of elements) -- two elements
    // that are merely structurally-equal-but-distinct objects are genuinely
    // different members of a Set.
    const bs = b as Set<unknown>;
    if (a.size !== bs.size) return false;
    for (const v of a) if (!bs.has(v)) return false;
    return true;
  }

  if (Array.isArray(a)) {
    const ba = b as unknown[];
    if (a.length !== ba.length) return false;
    return a.every((v, i) => structuralEqualInner(v, ba[i], seen));
  }

  // Any other exotic built-in (RegExp, DOM nodes, a real Path2D, etc.) that
  // isn't a plain object falls through to here -- treat it as *not* equal
  // by default rather than comparing (typically zero) own enumerable keys,
  // which would otherwise silently treat any two distinct instances as
  // identical. Safe default: this only means an extra recompute, never a
  // missed update.
  if (aTag !== "[object Object]") return false;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      structuralEqualInner((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen),
  );
}
