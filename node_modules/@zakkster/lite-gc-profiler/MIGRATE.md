# Migration notes

## v1.10.0

Additive, with **one behaviour change** worth reading before you upgrade.

### Breaking-ish: unknown rule keys now throw on `checkNoGc`

Before v1.10.0, `checkNoGc` silently ignored rule keys it did not recognise:

```js
checkNoGc(summary, { maxMajors: 0 });     // plural typo
// -> { verdict: 'pass', checked: {} }    // verified NOTHING, reported green
```

The ops and frames lanes have rejected unknown keys since v1.5.1; the primary
lane never did, and `llms.txt` documented the behaviour as universal. It now
is, including keys nested under `phases` and `perRegion`.

**If you upgrade and start seeing `TypeError: checkNoGc: unknown rule "..."`,
that gate was not gating.** The error names the closest real rule.

### New: gating memory the heap channel cannot see (G25)

`maxArrayBuffersGrowth` gates net growth of ArrayBuffer backing stores. See
the README section; the short version is that it needs `stabilize: 'deep'`
(or `forceSettle()`), it is node-only, and it is inconclusive rather than
`pass` wherever it cannot verify.

`summary` gains `arrayBuffers` and `external` blocks. Both are always present,
so consumers reading the envelope by shape are unaffected.

There is deliberately **no `maxExternalGrowth`**; passing one throws with the
measurement that disqualified it.

### New: `stabilize: 'deep'`

Two forced collections per anchor instead of one. **This changes
`bytesPerOp`** (measured: 25.9 -> 38.8 on a clean fixture, because a more
thorough start anchor lowers the baseline), which is exactly why it is opt-in
and why plain `stabilize: true` is untouched. Existing thresholds keep their
meaning unless you opt in.

`measureFrames` and `measureOpsAsync` reject `'deep'` with a `RangeError`
rather than downgrading silently.

### New: forced-GC provenance

`summary.gc` gains `forced`, `ownForced` and `foreignForced` (node only).
Non-zero `foreignForced` means something outside the library forced a
collection inside your measured window. Diagnostic; nothing gates on it.

Note that on the synchronous lanes the observer may not have delivered GC
entries by the time `summary()` is taken -- the same caveat that already
applies to `gc.count` and friends -- so treat `forced: 0` there as "not yet
observed" rather than "none happened".

## v1.9.1

Support surface. **Docs, templates and error-message text only** -- no API
change, no behaviour change, nothing to migrate.

### What's new

- **`INCONCLUSIVE.md`**, shipped in the package. The triage table for the
  third verdict: every reason code, what it means, and the fix. Promoted out
  of COOKBOOK Recipe 16 to where a first-run `inconclusive` actually lands,
  and expanded to cover all seven reason codes plus the null/NaN cases.
- **Error messages now name a next step.** `GcInconclusiveError` picks an
  actionable hint from what the report knows (source, reason code) and points
  at `INCONCLUSIVE.md`. The `source: 'uasm'` construction error now explains
  that cross-origin isolation is a response-header decision, and names the
  two headers.
- **A 60-second quickstart** at the top of the README, ending in `gateBadge`
  output so the payoff is visible before the concepts are.
- **Issue templates** for false pass, false fail-or-inconclusive, and docs.
  The false-pass template requires the report JSON, because that is the field
  that makes the class diagnosable at all.

### If you match on error message text

`GcInconclusiveError.message` is longer than it was. The parts that were
already there are unchanged and still in the same order -- the source, the
list of unverifiable rules, and the `allowInconclusive` mention -- so
substring matching on those still works. The hint is inserted between the
rule list and the `allowInconclusive` sentence.

Matching on the *exact* full string was never supported and is not now.

## v1.9.0

Batch 12: two fail-opens closed (H2, H1). **Additive only** -- no breaking
changes to v1.8.x callers, with one behaviour change confined to
`source: 'uasm'`, described below.

### What's new

Two fields on `summary.uasm`:

- `granularityBytes: number | null` -- the smallest non-zero step observed
  between consecutive uasm readings in the window. `null` when no step
  occurred; that means *not measured*, and it is never `0`.
- `belowGranularity: boolean` -- `true` when the window's net displacement is
  not resolvable above that floor.

One new inconclusive route: `reason: 'uasm_below_granularity'`, added to the
report only when it applies.

### The one behaviour change

On `source: 'uasm'` **only**, `maxAllocRate` now routes to `inconclusive`
instead of `pass` or `fail` when the window could not resolve growth above
the channel's own quantum. The same applies to `maxExtraAllocRate` on a
differential and to `maxAllocRate` under `gateReps`.

If a uasm gate of yours turns inconclusive on upgrade, that gate was not
measuring what it claimed. Two ways forward:

1. **Sample more, or over a longer window**, until the workload moves the
   channel by more than one quantum. This is usually the right fix and often
   just means adding a couple more `await gc.sampleUasm()` calls.
2. **Gate `heap` instead.** If the workload genuinely allocates less than one
   uasm quantum across the whole window, `uasm` cannot answer your budget
   question at that resolution and no amount of arithmetic will make it.

`{ allowInconclusive: true }` remains available, but reach for it last: it
turns the new signal back off.

### What deliberately did NOT change

- **`growthRate` is still the raw net/time figure.** It is not zeroed when
  `belowGranularity` is true. Read the two together: the rate is the
  measurement, the flag is whether the measurement resolves.
- **Summaries produced by v1.2.0-v1.8.0 gate exactly as before.** The check
  is `belowGranularity === true`, so a stored or hand-built summary that
  predates the field is unaffected. Treating "field absent" as "unresolved"
  would have turned every archived uasm artifact inconclusive overnight --
  a breaking change wearing a safety fix's coat.
- **Per-op and per-frame byte rules are untouched.** `maxBytesPerOp` and
  `maxBytesPerFrame` share the `needsUasm` matrix cell but their actual
  numbers come from heap deltas, so the uasm floor does not speak for them.
- **node and Chrome `heap` gates are entirely unaffected.** H2 exists because
  `measureUserAgentSpecificMemory()` quantizes; `process.memoryUsage()` and
  `performance.memory` do not, in the way that matters here.

### H1: no migration

Report-path percentiles now verify order before sorting and sort only on
violation. Purely internal; identical outputs, bounded time on large windows.

### Tooling

`npm run coverage` is new and is wired into `prepublishOnly`: the full suite
under three floors (lines 95 / funcs 95 / branches 85), shipped files only.
Consumers are unaffected -- this gates publishing, not installing.

## v1.8.0

Batch 11: multi-context frame aggregation. **Additive only** -- no
breaking changes to v1.7.x callers.

### What's new

Three functions on the main entry:

- `aggregateFrameReports(reports, opts?)`
- `checkAggregateFramesReport(multi, rules)`
- `assertAggregateFramesReport(reports, rules, opts?)`

Result schema: `'lite-gc-frames-multi/1'`.

Rule vocabulary: same as `checkFrames` -- `maxBytesPerFrame`,
`maxMajorsPerKFrame`, `maxMinorsPerKFrame`, `maxPauseMsPerFrame`,
`maxDroppedFrames`. No new `VERDICT_MATRIX` rows.

### When to reach for it

If your CI runs `assertFrames` on a single scheduler in one context,
nothing changes. Keep using `assertFrames`.

If your render pipeline is distributed -- multi-worker OffscreenCanvas
rendering, a physics thread + a render thread, N `worker_threads`
running the same simulation -- and a per-thread gate would miss
cross-context drops or retention, wrap your workers' `measureFrames`
results and gate the aggregate:

```js
import { Worker } from 'node:worker_threads';
import { assertAggregateFramesReport } from '@zakkster/lite-gc-profiler';

const reports = await Promise.all(workerPaths.map(runOne));
assertAggregateFramesReport(reports, {
    maxBytesPerFrame: 512,
    maxDroppedFrames: 5
});
```

### What the aggregate reports and why

- `bytesPerFrame`: frames-weighted, `total_bytes / total_frames`. Same
  math as the v1.7.0 ops aggregator: a small-frames context with a
  huge rate cannot swamp a large-frames context with a tiny rate.
- `bytesPerFrameStable`: nuanced AND. `true` only when no context
  reports `false` AND (every context reports the flag OR none do).
  Mixed presence yields `false` -- silence from a lane that could
  report is unknown provenance.
- `majorsPerKFrame` / `minorsPerKFrame`: frames-weighted rate. `null`
  if ANY context omitted or reported non-finite -- dilution guard.
- `maxPauseMsPerFrame`: MAX across contexts. `null` if any missing.
- `droppedFrames`: **SUM** across contexts. Frames dropped by
  different contexts accumulate -- three contexts each dropping one
  frame dropped three system-wide.
- `asyncResidual`: SUM. Missing counts as zero because it's a smoke
  signal, not a gated metric.
- `source`: unanimous or `'mixed'` (yields `inconclusive`).

### One field not aggregated: `frameTimes`

Percentiles are not compositional. A system-wide p95 cannot be
reconstructed from per-context summary p95s. The aggregate
deliberately omits `frameTimes` rather than inventing a plausible-
looking but wrong number. Per-context `frameTimes` are preserved in
`perContext[i]` for manual inspection.

If distribution stats matter to your gate, either (a) gate
`maxDroppedFrames` on the aggregate and hold per-context
`frameTimes` for logs, or (b) run one `measureFrames` on a
representative single context rather than aggregating.

### The v1.5.1 fail-closed discipline applies

`checkAggregateFramesReport` uses the same rule-validation surface as
`checkFrames`. Unknown rule keys throw `TypeError`. Non-finite
thresholds throw `RangeError`. Non-finite aggregate metrics route to
`inconclusive` (never `pass`).

### No `measureFramesAcrossWorkers` -- same reasoning as v1.7.0

Consistent with v1.7.0: no convenience primitive that owns worker
spawning. The Node `worker_threads` and browser `Worker(URL...)` APIs
differ meaningfully, and `globalThis.Worker` is `undefined` in Node.
You bring the workers; the aggregator handles the semantic.

## v1.7.0

Batch 10: multi-context aggregation. **Additive only** -- no breaking
changes to v1.6.x callers. Existing baselines, gates, and reports keep
working byte-identically.

### What's new

Three functions on the main entry:

- `aggregateWorkerReports(reports, opts?)`
- `checkAggregateReport(multi, rules)`
- `assertAggregateReport(reports, rules, opts?)`

Result schema: `'lite-gc-ops-multi/1'`.

Rule vocabulary: same as `checkOps` -- `maxBytesPerOp`, `maxMajorsPerKOp`,
`maxMinorsPerKOp`, `maxPauseMsPerOp`. No new `VERDICT_MATRIX` rows.

### When to reach for it

If your CI runs `assertOps` on a single hot path called from one thread,
nothing changes. Keep using `assertOps`.

If your workload is genuinely distributed -- N Node `worker_threads`,
N browser Web Workers, an app that spawns per-tab or per-tenant heaps
-- and a per-thread gate would miss cross-context retention, wrap
your workers' `measureOps` results and gate the aggregate:

```js
import { Worker } from 'node:worker_threads';
import { assertAggregateReport } from '@zakkster/lite-gc-profiler';

const reports = await Promise.all(workerPaths.map(runOne));
assertAggregateReport(reports, { maxBytesPerOp: 5 });
```

### What the aggregate reports and why

- `bytesPerOp`: ops-weighted, `total_bytes / total_ops`. Not a naive
  mean of per-context rates -- a 1-op context with a huge rate cannot
  swamp a 1M-op context with a tiny rate.
- `bytesPerOpStable`: logical AND. One context falling back to raw
  two-point degrades the aggregate flag. A gate cannot be more
  trustworthy than its least-trustworthy source.
- `maxPauseMsPerOp`: MAX across contexts. The worst pause anywhere in
  the system is the pause the aggregate reports.
- `source`: unanimous or `'mixed'`. Mixed-source aggregates are gated
  `inconclusive` with `reason: 'source_mismatch'`.

### The v1.5.1 fail-closed discipline applies

`checkAggregateReport` uses the same rule-validation surface as
`checkOps`. Unknown rule keys throw `TypeError`. Non-finite thresholds
throw `RangeError`. Non-finite aggregate metrics route to `inconclusive`
(never `pass`).

### No `measureOpsAcrossWorkers` -- deliberate

There is no convenience primitive that owns worker spawning. The
worker-spawning API differs meaningfully between runtimes (Node
`worker_threads` vs browser `new Worker(URL.createObjectURL(new Blob(...)))`),
and a portable wrapper cannot faithfully own both. `@zakkster/lite-worker`
is the recommended browser-side transport; it is not a hard dependency
of lite-gc-profiler because `globalThis.Worker` is `undefined` in Node
and a runtime-agnostic import would fail in the exact place CI gates run.

## v1.6.0

Batch 9: evidence lane. **Additive only** -- no breaking changes to
v1.5.x callers. Existing baselines, CI configurations, gate rules,
and rendered explain-sampling output keep working byte-identically.

### What's new

Three functions under the existing `./explain` subpath:

- `explainReport(report, opts?)` -- narrate any gate report
- `explainDiff(controlReport, candidateReport, opts?)` -- narrate two
  independent reports as a diff
- `gateBadge(report, opts?)` -- text / shields-JSON / SVG status badge

Import from `@zakkster/lite-gc-profiler/explain` alongside the existing
`startExplainSampling` and `formatExplainConsole`. All are pure
formatters -- they read gate reports and emit strings.

### Typical CI usage

```js
import { assertOps } from '@zakkster/lite-gc-profiler';
import { explainReport, gateBadge } from '@zakkster/lite-gc-profiler/explain';

try {
    await assertOps(signalSet, { maxBytesPerOp: 5 },
        { ops: 10_000, warmup: 500, stabilize: true });
} catch (err) {
    // err.report is the failing gate report
    console.error(explainReport(err.report, { colour: true }));
    // Or write a shields-compatible badge JSON to a file for CI to pick up:
    fs.writeFileSync('gc-badge.json', gateBadge(err.report, { format: 'shields-json' }));
    throw err;
}
```

`explainReport` handles all four report families (whole-window,
per-op, per-frame, per-op-async, plus compare variants) and both
violation shapes (`{ rule, metric, actual, limit }` from the newer
paths; `{ metric, actual, limit, reason }` from the legacy paths).

### Demo showcase

`demo/index.html` grew a formal-gate panel that runs
`assertFrames({ maxBytesPerFrame: 512 })` on the currently-selected
mode and renders the resulting badge + `explainReport` narrative
inline. The scope canvas above stays as-is -- the panel is additive.

### What is NOT changed

- `startExplainSampling` / `formatExplainConsole`: unchanged. Explain
  mode remains the "who allocated" primitive; the new formatters are
  the "what did the gate report" primitive. Both are useful; neither
  substitutes for the other.
- Report shapes: unchanged. `explainReport` accepts every existing
  report shape as-is, including reports without a
  `schema:'lite-gc-report/1'` tag.

## v1.5.2

Adversarial hardening in two passes (G99.9 + G99.10). **No new public
API**, and the 459-test v1.5.1 suite passed unchanged -- no test edits
were required. Seven defects closed: five on the verdict surfaces v1.5.1
did not reach (four of them fail-open), plus an infinite-loop DoS in
capacity handling and an observation-window hole.

Two things can change what you observe, both covered below: a ring
capacity above the new ceiling now throws instead of hanging or
allocating a gigabyte-scale ring, and your numbers no longer include GC
events that began before the profiler started. There is no shape change,
and everything else is observable only on input that previously produced
a wrong answer.

### Snapshot keys (no action required)

`summary.phases` and `summary.byRegion` now define their keys with
`Object.defineProperty` instead of plain assignment. This is what makes a
phase named `__proto__` land as a real, visible key instead of silently
setting the snapshot's prototype and disappearing from `Object.keys` and
`JSON.stringify`.

The object's prototype is untouched, so reads, iteration, spreads,
`JSON.stringify`, `deepStrictEqual`, `hasOwnProperty`, string coercion and
the `Record<string, PhaseSnapshot>` type all behave exactly as before:

```js
assert.deepStrictEqual(summary.phases, {});            // still holds
assert.equal(Object.keys(summary.phases).length, 0);   // also fine
```

Four assertions in this package's own suite needed exactly that edit.
If you snapshot summaries with `toMatchSnapshot`, `JSON.stringify` is
unaffected, so serialized snapshots still match.

### What now reports inconclusive instead of pass

All four were previously green while enforcing nothing:

- `checkNoGc(summary, { maxMajor: NaN })` and any other non-finite
  threshold. The ops and frames lanes have thrown on these since v1.5.1;
  the summary lane silently passed. It now returns `'inconclusive'` with
  `checked: { maxMajor: false }`. (Inconclusive rather than throwing, to
  match how that lane already treats unverifiable input.)
- A rules object whose threshold is a **getter returning different
  values on successive reads**. Thresholds are now read exactly once.
- `checkAgainstBaseline` against a baseline with **no comparable
  metrics** -- truncated file, missing `gc`/`heap` groups, schema drift,
  or an empty aggregate. Now `'inconclusive'` with
  `reason: 'no_comparable_metrics'`.
- `checkAgainstBaseline` against a baseline whose `max` values are
  **non-finite** (`NaN` in memory, `null` once saved through
  `JSON.stringify`, or a string if hand-edited). Those metrics now
  report `checked: false`. If some metrics survive, they still gate
  normally.

If a baseline of yours starts coming back inconclusive, it is telling
you the file cannot support the comparison -- regenerate it with
`createBaseline` rather than passing `allowInconclusive`.

### What changed in the numbers

`sampleHeap()` now **ignores non-finite readings** instead of letting
them poison `_heapPrev`. Previously one `NaN` sample (a mocked or
failing `performance.memory`) zeroed `allocBytes` for the rest of the
window: the same 60 MB of growth reported `59_999_000` bytes and
`'fail'` when clean, but `0` bytes and `'pass'` with
`checked: {maxAllocRate: true}` with one `NaN` in the middle.

If you were feeding `sampleHeap()` explicit byte counts and some were
non-finite, your `allocBytes` and `allocRateBytesPerSec` figures will
now be **higher** (correct) than they were, and an alloc-rate gate that
was passing may start failing. That is the bug being fixed, not a
regression.

### A guard caveat, now documented

The overlapping-measurement guard releases when a run settles. A run
that **never settles** -- a `measureFrames` scheduler that never fires
its callback, a `measureOpsAsync` op whose promise never resolves --
therefore holds the guard for the life of the process, and every later
measurement fails with "already in flight".

There is deliberately **no timeout release**: an abandoned run keeps
allocating into the same shared heap, so releasing the guard would
resume exactly the cross-contamination it exists to prevent. The error
message now says this instead of telling you to await calls you already
awaited. The fix is to repair the run that never finished.

The guard is also **per module instance**, not per process. If a build ends
up with two copies of `Gc.js` -- a source import alongside a bundled copy, or
two different versions resolved under `node_modules` -- each keeps its own
in-flight counter and neither sees the other's runs. Measured: two concurrent
`measureFrames` calls, one per copy, both completed with no rejection. They
share one heap, so the results silently contaminate each other exactly as
they would have before the guard existed. Import the profiler once.

---

### What throws now that used to hang or bomb

`opts.capacity` (every lane) and the `GcProfiler` constructor capacity
now have a ceiling: `MAX_RING_CAPACITY` = 2**24 = 16,777,216 slots
(256 MB of ring). Past it, `RangeError`. Before this release, capacities
above 2**30 **hung the process in an infinite loop** (a 32-bit shift
wrap in the power-of-two rounding), 2**30 itself crashed on a 16 GB
allocation, and anything large-but-allocatable was a silent resource
bomb. Documented usage is 8-256; the ceiling is two orders of magnitude
above that. If you genuinely need more, raise the constant -- the limit
exists to make the failure loud, not to ration slots.

### `record()` now validates its arguments

If you call `GcProfiler.record()` directly -- it is the synthetic test surface,
so most callers do not -- a `durationMs` that is negative, `NaN`, `Infinity` or
non-numeric now throws `RangeError` instead of being coerced or accepted. A
non-finite `startTime` throws too. Valid usage is unchanged, including zero
durations, an omitted `startTime`, and the arbitrary-timestamp injection tests
rely on.

### What your numbers no longer include

`start()` and `reset()` are now hard cutoffs. Entries whose `startTime`
precedes them are dropped even when node delivers them later (sync
GC-heavy code queues its 'gc' entries and node hands that backlog to
observers registered later in the same turn).

Previously a profiler started right after a sync workload inherited the
workload's GC history: a zero-GC gate over quiet code falsely failed,
phase sums diverged from `gc.count`, and `reset()` could be repopulated
by pre-reset events. If a gate of yours starts **passing** after this
upgrade, it was previously blaming your code for GC it did not cause.
If you *want* the old behaviour -- counting a backlog you did not
observe -- there is no switch for it; start the profiler before the
workload instead.

`record()` (the synthetic test API) is deliberately exempt from the
floor: tests inject events with arbitrary timestamps.

## v1.5.1

Adversarial hardening (G20). **No new public API**, and the 425-test
v1.5.0 suite passed unchanged before the new torture pinned the fixes.
The only visible behaviour change is that gates which were previously
enforcing nothing now throw at setup instead of returning `'pass'`.

### What throws now that used to silently pass

- `TypeError` if `rules` contains a key the lane doesn't implement.
  Typos like `maxBytesPerOP` (capital `P`) get an error naming the
  offending key and suggesting the intended rule (`maxBytesPerOp`).
  `compareFrames({ maxExtraBytesPerOp: N })` also throws now -- that
  rule belongs to `compareOps`, not `compareFrames`.
- `RangeError` if a rule's value is not a finite number.
  `{ maxBytesPerOp: NaN }`, `{ maxBytesPerOp: '20' }`, and
  `{ maxBytesPerOp: Infinity }` all throw. A non-finite threshold
  cannot enforce anything (`x > NaN` is always false).
- `RangeError` if `opts.capacity` is not a positive integer.
  Previously three lanes disagreed: `measureOps` treated `0`/`NaN` as
  256; async lanes treated `NaN`/`Infinity` as 0; `-1` threw. All lanes
  now require a positive integer.

If your gate configuration was already valid, nothing changes.

### What changed under `Promise.all`

Every lane measures one shared heap. Two measurements running
concurrently silently contaminate each other's readings -- a clean
workload and a leaky one running in parallel read the same. **Overlapping
measurements now throw** (or reject, for the async lanes) instead of
returning silently-wrong numbers. The guard releases on settle,
including after a throw. (v1.5.2 note: "settle" is load-bearing -- a run
that never settles at all does hold the guard for the life of the
process. See the v1.5.2 section.)

Measurements run sequentially. That is what `compareOps` /
`compareFrames` / `compareOpsAsync` do internally, and it is the only
answer under a shared heap.

### What changed on aborted runs

A workload that throws inside the ops-lane `for` loop previously
skipped `gc.stop()` and left the `PerformanceObserver` registered for
the life of the process. Growth was linear -- ~6 KB per aborted run,
~9.4 MB over 1600 -- and the orphaned observers kept attributing GC
events, so later measurements in the same process read inflated
`bytesPerOp`. The loop is now wrapped in `try`/`finally`. `stop()` is
idempotent, so the happy path is unchanged.

### Documented, not changed: sync `measureOps` GC-event counts

`result.summary.phases.steady.gc.major` and `.minor` have always read
zero on a sync `measureOps` run under heavy churn, because
`PerformanceObserver` delivers on event-loop turns and a sync loop
never yields. This is by design -- the ops lane exposes only
`bytesPerOp` (memory reading, no observer turn required) precisely for
this reason. Async lanes (`measureOpsAsync`, `measureFrames`) do capture
events correctly because every `await` yields the event loop. The README
now spells this out where it wasn't before.

## v1.5.0

Batch 8: serialized async ops (G19). **Additive only** -- no breaking
changes to v1.4.x callers. Existing baselines, CI configurations, and
gate rules keep working byte-identically.

### What's new

Five new public functions: `measureOpsAsync`, `checkOpsAsync`,
`assertOpsAsync`, `compareOpsAsync`, `assertCompareOpsAsync`. All are
`async` except `checkOpsAsync` (gate an existing result -- sync).

### When to reach for `measureOpsAsync` vs `measureOps`

- **`measureOps`** for synchronous hot paths -- Solid signals,
  synchronous mutations, tight loops that don't await.
- **`measureOpsAsync`** for async hot paths -- Preact-Signals,
  Svelte 5 runes with async scheduler, batched effects, async
  data mutations. Any workload where `fn(i)` returns a promise
  and the meaningful work happens across `await`.
- **`measureFrames`** for render-loop questions -- work distributed
  across scheduled frame ticks with a frame budget to hit.

The three lanes measure different things. Pick the one that matches
your workload's shape; their gates compose freely.

### Serialization contract

`measureOpsAsync` awaits `fn(i)` fully before starting `fn(i+1)`. Ops
do not overlap under this primitive. What `fn` does inside its own
promise is `fn`'s problem, surfaced via `asyncResidual` in the result.

If your workload has ops that spawn work outlasting their own return,
`asyncResidual` will be non-zero. Log it, assert against it, or ignore
it -- your choice. Full interleaved-async attribution across ops is a
v1.6.0+ concurrency-lane concern (G20 workers).

### Stabilize default parity with frame lane

`measureOpsAsync` follows the v1.4.0 frame-lane rule: `stabilize`
defaults ON when `globalThis.gc` is available. This is a deliberate
divergence from the sync `measureOps` default (opt-in). Reasoning:

- Sync `measureOps` is designed for tight-loop measurement where any
  scheduler perturbation matters. Making stabilize opt-in there
  preserves the passive default.
- `measureOpsAsync` is already async, already calls `settle()`. Two
  forced GCs at steady boundaries are marginal cost. The gain --
  compacted-live-set delta instead of raw two-point noise -- is
  dramatic.

Same principle already applied to `measureFrames` in v1.4.0.

### Portability lessons carried forward

The G18.5 torture pins use `Array(1024).fill(i)` as the portable
typed-slot payload and assert relative to the measured clean floor,
not against absolute byte thresholds. If your CI ran the v1.4.x frame
torture cleanly on both M4 Pro and Intel, the v1.5.0 async ops
torture should behave the same way.

If you're writing your own gate tests, the pattern to internalize:

```js
// Measure the floor on THIS machine
const clean = await measureOpsAsync(cleanFn, opts);
const floor = Math.max(clean.bytesPerOp, 64);   // guard against 0

// Gate a candidate relative to the floor
const candidate = await measureOpsAsync(candidateFn, opts);
assert.ok(candidate.bytesPerOp < 4 * floor,
    'candidate must stay within 4x of the measured clean floor');
```

Fixed-size typed-array payloads (`new Array(1024).fill(x)`,
`new Float64Array(256)`) are heap-visible with predictable size on
every V8 build. Plain-object payloads have V8-version-dependent sizes
(pointer compression on/off, header layout changes) and don't survive
cross-machine comparison.

## v1.4.0

Batch 7: the frame lane. **Additive only** -- no breaking changes to
existing v1.3.x callers. Existing baselines, CI configurations, and
gate rules keep working byte-identically.

### What's new

Five new public functions: `measureFrames`, `checkFrames`,
`assertFrames`, `compareFrames`, `assertCompareFrames`. All the
`measure*` and convenience forms are `async` -- frames are inherently
async, driven by a scheduler. `checkFrames` is sync (gate a result
you already have).

Five new `VERDICT_MATRIX` rules: `maxBytesPerFrame`,
`maxMajorsPerKFrame`, `maxMinorsPerKFrame`, `maxPauseMsPerFrame`,
`maxDroppedFrames`. The last one is the first source-agnostic rule
in the matrix -- it gates on `source='none'`, which no rule did
before v1.4.0. If your code walks `VERDICT_MATRIX` and asserts every
rule is `'no'` on `'none'`, you'll need to add
`maxDroppedFrames` to a source-agnostic set:

```js
const SOURCE_AGNOSTIC_RULES = new Set(['maxDroppedFrames']);
for (const rule in VERDICT_MATRIX) {
    if (SOURCE_AGNOSTIC_RULES.has(rule)) {
        // 'yes' on every source
    } else {
        // 'no' on 'none'
    }
}
```

### When to reach for `measureFrames`

Use it whenever the question is "how does this behave inside a
render loop?" -- specifically:

- You want to gate `bytesPerFrame` retention slope over a sustained
  render window, not `bytesPerOp` on a hot-path call.
- You care about frame drops (work-time exceeding a budget), not
  per-op wall clock.
- You're comparing two implementations under sustained load, not
  isolated micro-benchmarks.

Use `measureOps` for the hot-path question ("what does one call
cost?"). The two lanes measure different things and their gates
compose freely.

### Attribution: cooperative vs fire-and-forget

For a frame function that fully awaits its own work, attribution is
accurate. For frame functions that spawn fire-and-forget promises
or timers, V8's async-context propagation can attribute allocations
to whichever phase is current when the perf_hooks GC callback
delivers -- not the frame that spawned the work. In practice this
matters when the workload interleaves async continuations across
frames.

The result includes `asyncResidual` -- bytes the heap grew *after*
`gc.settle()` returned. Non-zero means work outlived the measurement
window. Use it as a smoke signal: log it, or assert against it
directly.

Full interleaved-async attribution is a v1.5.0 concurrency-lane
concern.

### Scheduler selection

Default is `'auto'` -- uses `requestAnimationFrame` if the runtime
has one, otherwise a self-correcting `setTimeout` polyfill. Explicit
choices:

- `scheduler: 'raf'` throws `RangeError` at setup if raf is
  unavailable. No silent fallback: explicit intent is honored.
- `scheduler: 'polyfill'` forces the setTimeout pacer.
- `scheduler: (cb) => setTimeout(cb, 0)` -- the escape hatch for
  deterministic tests. 300 frames in ~150ms wall-clock instead of ~5s.

## v1.3.1

Hardening patch; **no breaking changes.** Existing v1.3.0 code, baselines,
and CI configurations keep working byte-identically.

### What changed

One new option: `stabilize: boolean` on `MeasureOpsOptions`. Default
`false`; opt in per call. When true, forces a full GC at each
steady-phase boundary so `bytesPerOp` reflects surviving-allocation
delta (retention) rather than transient allocation. Applies to
`measureOps`, `assertOps`, `compareOps`, `assertCompareOps` via the
existing `opts` inheritance.

Also new: `summary.phases.stabilize` sub-summary block, present only
when `stabilize: true` was passed.

### No API changes for existing callers

If you don't pass `stabilize: true`, nothing changes. Same function
signatures, same result shapes, same event attribution, same
verdict/matrix behavior. Baselines captured under v1.3.0 stay valid
against v1.3.1 without regeneration.

### When to opt in

- Cold CI shards where `assertCompareOps` is the first workload to
  run in the process. See README "Cold CI" section.
- Any zero-allocation claim where you care about **retention** rather
  than transient churn ("my signal notification retains zero bytes"
  is a stronger claim than "my signal notification allocated zero
  transiently").

### When NOT to opt in

- Warmed workloads that already produce deterministic bytes/op.
- Browsers or sandboxed CI where `--expose-gc` isn't available;
  `stabilize:true` throws `RangeError` at measurement time in those
  environments.
- GC-event-count gating (`maxMajorsPerKOp`, `maxPauseMsPerOp`). The
  forced-GC events arrive asynchronously via `perf_hooks` and typically
  after `measureOps` returns; the `summary.phases.stabilize.gc.*`
  counters are unreliable and should not be gated on. Recommended:
  use `stabilize:true` for `maxBytesPerOp` gating, `stabilize:false`
  for event-count gating. Both are honest on their own axes.

### Required runtime flag

`stabilize:true` requires `node --expose-gc`. Without it, the option
throws `RangeError` at measurement time with actionable guidance --
the error names `--expose-gc` explicitly so CI configurers know the
exact fix. If your existing CI shard already runs with `--expose-gc`
(the recommended setup for anything using this profiler), no change
needed.

### No matrix growth

No new rules in `VERDICT_MATRIX`; no new source columns; no changes to
existing rule verifiability. `stabilize` is a mode on the measurement
harness, not a new gate axis. Existing baselines and gate configs
continue to apply.

### Copyright

Zahary Shinikchiev. MIT.
