# You got `inconclusive`. Here is what to do.

Most people meet this verdict on their first run, decide the library is
broken or fussy, and reach for `{ allowInconclusive: true }`. That is the
one move this page exists to talk you out of.

**`inconclusive` is not a failure mode. It is the answer.** The gate is
telling you it could not verify the rule you asked about — and it refuses to
report `pass`, because a green build that means nothing is worse than a red
one. Every other profiler would have said `pass` here. That difference is the
entire reason this package exists.

So: find your line in the table, apply the fix, and keep the gate honest.

---

## 30-second triage

| What you see | What it means | What to do |
| --- | --- | --- |
| `source: 'none'`, all rules `false` | this runtime exposes no GC and no heap channel — Firefox, Safari, or a sandbox with `perf_hooks` stripped | run the gate in node or Chrome; or gate the frame lane, which works everywhere |
| `checked: { maxAllocRate: false }`, `source: 'gc'` or `'heap'` | fewer than two heap samples, so there is no delta to compute a rate from | call `sampleHeap()` at least twice, or use `measureOps` / `measureFrames`, which sample for you |
| `checked: { maxMajor: false }`, `source: 'heap'` or `'uasm'` | event-kind rules need real GC events; Chrome exposes bytes, not kinds | gate `maxAllocRate` instead, or run the same gate in node where kinds exist |
| `reason: 'uasm_below_granularity'` | the `uasm` channel could not resolve growth above its own quantum | sample more times or over a longer window; if it still cannot, gate `source: 'heap'` — see below |
| `checked: { maxArrayBuffersGrowth: false }`, `settled: false` | the window was not anchored by two forced collections, so the growth figure is not trustworthy | use `stabilize: 'deep'` on `measureOps`, or call `gc.forceSettle()` before each `sampleHeap` on the manual path |
| `checked: { maxArrayBuffersGrowth: false }`, `supported: false` | `process.memoryUsage()` was never passed to `sampleHeap` | pass it as the third argument: `gc.sampleHeap(t, mu.heapUsed, mu)` |
| `checked: { maxArrayBuffersGrowth: false }`, `source` is not `'gc'` | only node reports external memory | run the external gate under node; Chrome and uasm cannot answer it |
| `reason: 'source_mismatch'` | `compareGc` got a control and candidate measured on different sources | measure both sides the same way; a node control cannot certify a browser candidate |
| `reason: 'mixed_sources'` | `gateReps` got reps that do not share one source | run all reps in one runtime |
| `reason: 'fingerprint_mismatch'` | the baseline was captured on a different machine or runtime | re-capture the baseline here, or gate ratios instead of absolutes (COOKBOOK Recipe 17) |
| `reason: 'no_comparable_metrics'` | the baseline and this run share no metric at all | the baseline predates the metrics you are gating; re-capture it |
| `reason: 'invalid_baseline'` | the baseline file is malformed or from an incompatible schema | re-capture; do not hand-edit baseline JSON |
| `reason: 'not_observed'` | the summary came from a profiler that was never `start()`ed and never received synthetic data — it observed nothing, so a green gate would be a lie | call `gc.start()` before your workload; `withGcGate` and `measureOps` do this for you |
| `reason: 'partial_report'` (CLI) | the child process died before writing a full report | read the child's own exit code, reported alongside; this is usually a crash in your workload, not in the gate |
| a metric reads `null` in an aggregate | some context omitted or broke that metric | find the context. A `measureOps` report legitimately carries no GC rates — that is not a bug, and it is deliberately not averaged as zero |
| a metric reads `NaN` or `Infinity` | the measurement itself broke | look for a mocked timer, a patched `process.memoryUsage`, or a workload that threw mid-run |
| a threshold you passed is `NaN` or `Infinity` | a non-finite threshold cannot decide anything | fix the threshold. The gate will not guess what you meant |

---

## The three you are most likely to hit first

### `source: 'none'` — nothing to measure with

You are on Firefox or Safari. Neither exposes a GC event stream, and neither
exposes `performance.memory`. There is no arithmetic that fixes this: the
data does not exist in that runtime.

What still works there is the frame lane. Long-frame anomaly detection needs
no memory API, so `measureFrames` and its rules (`maxDroppedFrames`,
`maxPauseMsPerFrame`) remain meaningful everywhere:

```js
const result = await measureFrames(renderOneFrame, { frames: 300 });
assertFrames(result, { maxDroppedFrames: 3 });
```

If you need byte-level gating, run that gate in CI under node and let the
browser lane cover what it can. Gating the same claim twice, in two runtimes,
with each gate honest about its own limits, is the intended shape.

### Fewer than two samples — no delta exists

Every rate and every byte-growth rule is a difference between two points.
One sample is not a difference.

```js
const gc = new GcProfiler();
gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);   // point 1
runWorkload();
gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);   // point 2
assertNoGc(gc.summary(), { maxAllocRate: 1024 * 1024 });
```

`measureOps`, `measureFrames` and `measureOpsAsync` handle this for you. If
you are driving `GcProfiler` by hand and a byte rule is coming back
unverified, count your `sampleHeap` calls first — it is almost always this.

### `uasm_below_granularity` — the channel cannot see that small

`performance.measureUserAgentSpecificMemory()` reports **quantized** figures,
and the quantum is not contractual. If your workload moved the heap by less
than one bucket, the readings cannot tell "nothing was allocated" apart from
"something smaller than the quantum was allocated" — so the gate withholds
the verdict rather than inventing one.

Check what the channel actually resolved:

```js
const s = gc.summary();
console.log(s.uasm.granularityBytes);    // the measured quantum, or null
console.log(s.uasm.belowGranularity);    // true when the window did not resolve
```

- `granularityBytes` is `null` → the readings never changed at all. The
  channel demonstrated no resolution whatsoever in that window.
- `granularityBytes` is a number → that is the smallest step this window
  observed. Your workload needs to move the heap by **more** than that before
  a rate means anything.

Two fixes, in order of preference:

1. **Sample more, or over a longer window.** Usually this is two more
   `await gc.sampleUasm()` calls. A window that spans more work crosses more
   quanta.
2. **Gate `source: 'heap'` instead.** If the workload genuinely allocates
   less than one quantum across the whole run, `uasm` cannot answer your
   budget question at that resolution, and no amount of arithmetic will
   change that. `performance.memory` is coarser in accuracy but finer in
   granularity — for small budgets it is the better instrument.

Note that `summary.uasm.growthRate` still carries the raw number in this
state. It is deliberately not zeroed: the rate is the measurement, the flag
is whether the measurement resolves. Read them together, and do not gate on
the rate alone.

---

## What not to do

```js
// Don't.
assertNoGc(summary, rules, { allowInconclusive: true });
```

`allowInconclusive` exists, and it is legitimate — for the case where you
have genuinely decided that an unverifiable environment should not block a
merge. Use it **deliberately, per call, with a comment saying why**. Never as
a project-wide default, and never as the first response to a verdict you did
not expect. Turning it on globally converts this library into every other
profiler: one that always says yes.

The honest pattern keeps the third state visible in CI:

```js
const report = checkOps(result, { maxBytesPerOp: 32 });

if (report.verdict === 'inconclusive') {
    console.warn(explainReport(report));       // says which rules, and why
    if (process.env.CI) process.exit(2);       // 2 = could not verify
}
```

Exit codes keep the two apart in a pipeline, and the CLI uses the same
convention:

| code | meaning |
| :--: | --- |
| 0 | pass |
| 1 | fail — a budget was exceeded |
| 2 | inconclusive — the gate could not verify |
| 3 | infrastructure error — the gate itself could not run |

A pipeline that treats 2 as 0 has switched the safety off. A pipeline that
treats 2 as 1 will be red for reasons nobody can act on. Treat it as its own
state: warn, surface, and fix the measurement.

---

## Allocation attribution codes (G27)

These are NOT inconclusive verdicts. They appear on
`result.attribution.reason` when you ran `measureAllocs(fn, { attribute: true })`
and the sampler could not produce a profile. Attribution is advisory: its
absence never changes a verdict, and `bytesPerCall` gates exactly as it would
without `attribute`. You are seeing one of these because the "where did it
allocate" hint is missing, not because the measurement failed.

| `attribution.reason` | What it means | What to do |
| --- | --- | --- |
| `no_inspector` | this runtime has no `node:inspector` -- a browser, a worker, or a locked-down sandbox | attribution is Node-only; the `bytesPerCall` number is still valid. Run under Node to get sites |
| `connect_failed` | an inspector `Session` could not connect -- usually another inspector is already attached (`--inspect`, a debugger, another profiler) | detach the other inspector, or drop `--inspect` while gating |
| `start_failed` | the session connected but `HeapProfiler.startSampling` was rejected -- an older Node, or a restricted environment | the gate still works on the delta; upgrade Node if you need sites |
| `stop_failed` | sampling ran but `stopSampling` returned no profile -- a session torn down early, or a runtime quirk | re-run; if it persists, gate without `attribute` and profile the workload manually |

---

## Pool-escape watch codes (watchPool, v1.14.0)

These appear on `report.reason` when `watchPool(...).settle()` could not run its
detector. They are NOT inconclusive verdicts -- watchPool is advisory and never
gates. And note the deeper rule of this lane: even a fully-available run with an
empty `escapes` list is NOT a pass. Absence of detected escapes is never proof
that none occurred; a finalizer may not have run yet, or may never run. There is
deliberately no clean/pass verdict to be inconclusive about.

| `report.reason` | What it means | What to do |
| --- | --- | --- |
| `no_registry` | this runtime has no `FinalizationRegistry` -- a very old engine | the pool-escape canary is unavailable here; there is no fallback that can observe a collection |
| `no_gc` | there is no forceable `globalThis.gc` to drive the settle loop -- finalizers cannot be provoked on demand | run under `node --expose-gc`. Without it, `settle()` returns `available: false` rather than hanging |

Remember the shape: `assertNoEscapes` throws only on a NON-empty escapes list. On
an unavailable report, or an empty one, it is a no-op. Use it to fail a run when
an escape is *seen*, never to certify that none exists.

---

## Still stuck?

`explainReport(report)` prints which rules went unverified and why, in
readable form. Include its output — and the report JSON — when opening an
issue. There is a template for exactly this.

If a gate returned **`pass`** on something you believe it could not actually
verify, that is the most serious bug class in this package. Please report it
as a false pass, with the report JSON attached; those get priority over
everything else.
