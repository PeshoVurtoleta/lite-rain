# lite-rain -- enriched roadmap (2026-08-21)

**Supersedes** the prior audit-ledger ROADMAP (F1-F9). That document was
directionally right about the leak but (a) inferred rather than reproduced,
(b) carried two stale metadata claims, and (c) leaned on a
`ROADMAP-FX-REVIVAL-2026-07.md` + "Recipes A-I" that **do not exist in the
tree** (R-14). This version pulls the code, runs it, and anchors every session
to a reproduced finding.

**Method note.** Every S1/S2 finding below was reproduced against `RainEngine.js`
at HEAD (v1.0.0), not read off the source. `lite-color` is not installed in the
package, so reproduction swapped the one `import { toCssOklch }` line for a local
stub -- the physics paths (`spawn`, `updateAndDraw`) never call it with a string
color, so the swap is faithful to every path a finding touches.

**Blueprints borrowed.** Harness + tier layout from `@zakkster/lite-bvh`
(`test/torture.mjs` + `test/torture/harness.mjs`). Aerodynamics + the
depth-knob/speed-knob feature discipline from `@zakkster/lite-confetti`
(v1.28.0: `wind`, `gust`/`gustRate`, `turbulence`, `sway`/`swayRate`, `drag`,
floor/wall/ceiling box, `settle`, `friction`, `export const presets`).

---

## 0. State

| Field | Value |
| --- | --- |
| Published | `@zakkster/lite-rain@1.0.0`, npm = HEAD, 1 commit |
| Size | 7.2 KB single-file ESM (`RainEngine.js`) |
| Runtime dep | `@zakkster/lite-color` (**pinned `^1.0.5`; library is at `v2.1.0`** -- R-11) |
| Test | `vitest` (15 assertions), NOT `node:test` -- devDep to remove |
| Torture | none |
| Verdict | Solid core (terminal velocity, precomputed `tailMult`, bucketed streaks). But it missed the culling fix snow received: it has a **silent unbounded pool leak** (R-01), a **NaN door that is wide open** (R-02), and neither the harness nor the presets its siblings ship. v1.1.0 is a **correctness** release. |

**Metadata is self-consistent** -- unlike the lite-arena/lite-scheduler
cross-wire, rain's `homepage`/`repository`/`bugs` all point at `lite-rain`. No
cross-wire finding. But grep the ecosystem for the `lite-color` floor before
trusting any devDep line: a `^1.0.5` pin two majors behind the installed library
is a copy-paste fossil, and if rain has it, siblings may too.

---

## 1. Shared law (holds every session)

1. **The pool is the contract.** 12 SoA typed arrays indexed by slot; `state[i]`
   in `{0 free, 1 falling, 2 splashing}` is the allocator. Any operation that
   leaves a slot in state 1 or 2 forever without a path back to 0 is a leak,
   full stop -- there is no free-list to audit, so the invariant is
   **behavioural**: under any finite force field, `count(state != 0)` returns to
   a bounded steady state and never climbs monotonically to `max`.
2. **Fail closed at the door. Null is not zero, and NaN is not a coordinate.** A
   non-finite config value or a non-finite `dt` must be rejected or clamped at
   entry -- never accepted, silently poison the pool, and surface three frames
   later as a screen that stops raining (R-02). This is the same failure class
   as lite-bvh B-03 and lite-aabb A-03.
3. **Bytes in a hot body, not instructions.** Every guard added below must be
   provably absent from the per-particle loop bodies in `spawn` and
   `updateAndDraw`. Validate at the door (once per call, or once per frame), not
   per particle. A validation layer that costs the fast path is a rejected
   design, not a tradeoff.
4. **Determinism is a shipped property.** With a seeded `rng`, two engines run
   identically frame-for-frame (reproduced: identical `x/y/state` after 120
   frames on matched seeds). Every feature that consumes randomness keeps this
   true, and the torture suite pins a snapshot so a refactor cannot silently
   break replay. Borrow confetti's fingerprint discipline: a feature that is OFF
   reproduces the pre-feature stream bit-for-bit.
5. **Every gate must be provably able to fail.** Every torture tier ships a
   deliberately-broken control variant (`RAIN_TORTURE_BREAK=1`) that exits
   non-zero. A gate that cannot fail is decorative.
6. **ASCII-only source** (`->`, `<=`, `x`, "degrees"; U+00D7 and U+00B5
   excepted). The current `// (star) FIX N` comments violate this (R-15).

---

## 2. Verified findings

Reproduced against `RainEngine.js` at v1.0.0 on 2026-08-21. **S1** = silent data
loss / pool corruption, **S2** = broken documented or implied guarantee, **S3** =
hygiene / contract gap.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **R-01** | **S1** | **Unbounded pool leak: state-1 drops are only ever recycled by reaching `y >= h`.** Any force that keeps a drop from falling past the floor leaks it forever. Snow's own source documents culling "X-axis wind leak AND Y-axis negative gravity leak"; rain never got the backport. | `gravity:-1500` -> after 400 frames `alive == 500/500`, sample `y ~ -18000` (rising forever). Low-density checkpoint series climbs `1300 -> 2000 -> 2000 -> 2000` (monotone to cap); control `gravity:+1500` holds flat `903..936` (recycles). `angle:-PI/2` -> 495/500. `wind:20000` -> 290 live drops at `x` up to ~79,000 on an 800px canvas, stroked invisibly until they happen to reach `h`. |
| **R-02** | **S1** | **The NaN door is open, and it compounds R-01.** A non-finite config (`gravity`, `wind`, `angle`, `maxSpeed`, ...) poisons `x/y/vy` to NaN on frame 1 for every drop. Because `NaN >= h` is `false`, poisoned drops **never recycle** -- one bad config value silently exhausts the pool AND blanks the screen, permanently. Not in the old ledger. | `new RainEngine(100,{gravity:NaN})`; `spawn`; `updateAndDraw` -> first live drop `{x:NaN,y:NaN,vy:NaN}`. |
| **R-04** | **S2** | **Spawn-window blowup under wind.** `windOffset = (h/gravity)*abs(wind)` sizes the spawn x-range. Strong wind or weak gravity makes it enormous, so most drops are born off-screen and are pure overdraw from frame 1 -- the spawn-side companion to R-01's missing cull. | `w=800,h=600,gravity=300,wind=20000` -> `windOffset=40000`, spawn `x in [-40000, 40800]` = an 80,800px band for an 800px canvas. |
| **R-03** | **S3** | **`dt` is clamped high but not low.** `if (dt > 0.1) dt = 0.1` in both `spawn` and `updateAndDraw`; a negative `dt` runs the integrator backward (drops rise, velocities invert). No lower bound, no finiteness check. | `updateAndDraw(ctx,-0.05,...)` -> sampled drop `y` decreases, `vy` flips sign. |
| **R-05** | S3 | **No dimension cache.** `areaModifier = (w*h)/100000` recomputed every `spawn`; snow caches on `(w,h)` change. Trivial cost, but convention parity and it sets up gust work. | `('_lastW' in e) === false`, `('_areaModifier' in e) === false`. |
| **R-06** | S3 | **No `RAIN_PRESETS`.** Snow ships three, confetti ships a whole `presets` object; rain ships none, so every consumer re-derives tuning. | source: no preset export. |
| **R-07** | S2 | **O(max) free-slot scan in `spawn`.** Linear scan `for i in 0..max` to find `state[i]===0`; at `max=8000` and low occupancy the scan still walks the whole pool per drop. Ring-cursor allocator is the fix. | `RainEngine.js:65`. |
| **R-08** | S2 | **Render scans the full pool 4x every frame.** Three bucket loops + one splash loop, each `for i in 0..max`, regardless of occupancy = up to `4*max` iterations/frame with, at low fill, almost no draws. Persistent per-bucket `Uint32Array` index lists filled in one binning pass is the snow fix. | `RainEngine.js:150-172`. |
| **R-09** | S3 | **Loop-invariant `this.config.*` loads inside hot bodies.** `config.angle`, `config.maxSpeed`, `config.splashBounce`, `config.splashSpread`, `config.splashLife*` re-read per particle per frame. Hoist to frame-top locals. | `RainEngine.js:107-128`. |
| **R-10** | S3 | **Splash magic constants unexposed.** Radius `z*(1.2 + abs(vy)/2000)` hardcodes impact scaling; expose `splashScale` (default preserves 1.2/2000). | `RainEngine.js:125`. |
| **R-11** | S3 | **Metadata (old F8 corrected).** The old ledger's "webgl keyword inaccurate" is stale -- rain has **no** `webgl` keyword. The real gaps: `lite-color` pinned `^1.0.5` while the library is `v2.1.0` (`toCssOklch({l,c,h,a=1})` still compatible -- verify then bump); `vitest` devDep; no `CHANGELOG.md`; no `VERSION` export; `"test": "vitest run"` not `node --test`; no `lite-gc-profiler`/`lite-leak` devDeps. | `package.json`; `LiteColor/*.js` exports. |
| **R-12** | S3 | **Test gaps.** 15 vitest assertions, no `--expose-gc`, no leak/soak, no determinism snapshot, no torture, no `dt`/dimension/NaN abuse -- which is exactly why R-01 and R-02 shipped. | `test/RainEngine.test.js`. |
| **R-13** | S3 | **No constructor validation.** `new RainEngine(0)` builds a silent no-op engine (spawn finds no slots, queries return empty). `new RainEngine(2.5)` silently truncates to `Float32Array(2)`. `-1` throws a raw allocator `RangeError`, not a library error. | as written. |
| **R-14** | S3 | **Planning-doc integrity.** The prior ROADMAP referenced `ROADMAP-FX-REVIVAL-2026-07.md` and "Recipes A-I" -- neither exists anywhere in the suite. Every recipe is inlined into the briefs below instead. | `find` over the tree: no match. |
| **R-15** | S3 | **Source violates the ASCII-only law.** `RainEngine.js` uses `U+2B50` (star) in `// (star) FIX N` comments; U+2B50 is not on the CLAUDE.md excepted list (`U+00D7`, `U+00B5`). | grep the file for non-ASCII. |

### The one invariant that catches the worst two at once

```
under any finite force field, count(state != 0) converges to a bounded
steady state and never climbs monotonically toward max
```

R-01 and R-02 both violate it immediately (climb to `max` and pin). It is
`O(max)` to sample, so it belongs in the soak tier (T7) and the leak regression
test -- never in a hot path. Make it the centrepiece of R1.

---

## 3. The torture suite (`test/torture.mjs`) -- spec

One harness, the lite-bvh ten-tier shape, adapted to a particle pool. Built once
in R0, extended by each later session. Mirror `LiteBvh/test/torture/harness.mjs`:
seeded xorshift32 PRNG (`RAIN_TORTURE_SEED` for replay), `check(cond, msgThunk)`
that builds the message only on failure, `die()` to stderr + exit 1, and a
`runOpsGate(fn, {ops})` wrapping `measureOps(..., { stabilize:'deep' })` +
`checkNoGc(summary, RULES)` with `RULES = { maxMajor:0, maxPauseMs:4,
maxArrayBuffersGrowth:0 }`. All scratch (the engine, a fake zero-cost ctx, index
buffers) allocated ONCE outside every loop. Tiers run STRICTLY SEQUENTIALLY --
lite-gc-profiler is one-measurement-at-a-time.

### Layout

```
test/
  torture.mjs           # entry: runs tiers in order, prints exactly "ok", exit 0/1
  torture/
    harness.mjs         # scratch pool, zero-alloc asserts, seeded PRNG, gc gate, fake ctx
    t0-laws.mjs         # metamorphic + conservation laws
    t1-degenerate.mjs   # NaN / Infinity / negative dt / zero dims / degenerate config
    t3-adversarial.mjs  # force fields crafted to leak the pool (the R-01/R-02 net)
    t4-handles.mjs      # constructor + config-key abuse (the R-13 net)
    t5-fuzz.mjs         # differential fuzz: pool count vs an independent scan oracle
    t6-alloc.mjs        # zero-alloc gate incl. maxArrayBuffersGrowth + direct buffer asserts
    t7-soak.mjs         # leak_cycles churn + the pool-conservation invariant
    t8-determinism.mjs  # seeded-rng snapshot: byte-identical replay, feature-off fingerprints
    t9-controls.mjs     # every gate above, deliberately broken, must exit non-zero
```

`test/` never enters `package.json` `files[]`. `npm pack --dry-run` proves it.

The fake ctx is a zero-cost stub (`beginPath/moveTo/lineTo/arc/stroke/fill` are
empty; `globalAlpha/lineWidth/...` are writable no-op props) so a torture run
measures the engine, never a canvas.

### Tier map (what each proves for rain)

- **T0 laws.** `clear()` zeroes all state; `spawn` then `clear` returns
  `count(state!=0)` to 0; a splash (state 2) only ever comes from a floor-hit
  streak (state 1); `z in [0.2,1.0]` for every live drop; `bucket[i]` matches
  the `z` band; higher `density` never yields fewer spawns for equal area/dt.
- **T1 degenerate.** Cross `spawn`/`updateAndDraw` with `dt` in
  `{0, -0.05, NaN, +Inf, 1e9, subnormal}`, `w`/`h` in `{0, -800, NaN, Inf}`,
  and config values (`gravity`, `wind`, `angle`, `maxSpeed`, `splash*`) each set
  to `NaN`/`Infinity`/negative. **Pin the decided policy for every cell** (throw,
  clamp, or documented no-op). "Silently poisons the pool" (R-02) is not one of
  the three.
- **T3 adversarial (the leak net).** Long runs (600+ frames) under: negative
  gravity; upward `angle` (`-PI/2`, and the full ring `0..2PI`); zero gravity +
  strong wind; `wind` at `+/-20000`; `maxSpeed` at 0; `density` far above what
  `max` can hold; alternating force flips every frame (teleport churn). After
  each run assert the conservation invariant AND that a subsequent normal frame
  still recycles. This is the tier that would have caught R-01.
- **T4 handles (the constructor/config net).** `new RainEngine(x)` for
  `x in {0, -1, 2.5, NaN, Infinity, 1e12}`; unknown config keys; `color` as
  object / string / garbage; `rng` returning out-of-range / NaN. Each gets a
  decided policy: throw a library error, or documented coercion.
- **T5 fuzz vs oracle.** Independent ground truth: a second scan that counts
  `state != 0` and validates every live drop is finite and on a plausible
  trajectory. Run 100k mixed `spawn`/`update` ops with random `dt`/dims/forces
  from a seeded corpus against both. Any divergence prints seed + op index + a
  one-env-var replay.
- **T6 alloc.** `runOpsGate` over a steady-state `spawn`+`updateAndDraw` loop at
  `maxMajor:0, maxPauseMs:4, maxArrayBuffersGrowth:0`, `stabilize:'deep'`. Plus a
  direct structural assertion no heap gate can substitute for -- after R2's index
  lists land, assert the per-bucket `Uint32Array.length` and the pool buffers'
  `byteLength` are identical before and after 10k frames (ArrayBuffer backing
  stores live outside the V8 heap; lite-gc-profiler documents a 152x blind spot
  there, which is why the direct assert is mandatory, exactly as in lite-bvh
  T6/B-08).
- **T7 soak + conservation.** `leak_cycles: 4096` build-up/tear-down cycles;
  after each assert `count(state!=0) == 0` post-`clear()` and the steady-state
  bound mid-cycle. Sample the heap ACROSS cycles, not within one.
- **T8 determinism.** Two engines, matched seeded `rng`, byte-identical `x/y/
  vx/vy/state/life` snapshot after N frames. Every R3 feature adds a
  fingerprint: with the feature OFF, the snapshot equals the pre-feature commit
  bit-for-bit (confetti's discipline).
- **T9 controls.** For every gate: an allocating op loop (a `[]`/closure per
  frame) fails T6; rotations-off... n/a; a cull-disabled build fails T3's
  conservation; a NaN config that bypasses the door fails T1; a mutated snapshot
  fails T8. `RAIN_TORTURE_BREAK=1` trips at least the T6 control.

---

## 4. Session order

```
R0 --> R1 --> R2 --> R3 --> R4     (single package, linear; no twin release)
```

`R1` is the **urgent** one: rain is published, users can `npm i` it today, and
R-01+R-02 are silent corruption. It is the equivalent of lite-arena's R1 in the
sibling roadmap -- do it first even though nothing downstream is blocked yet.
`R0` stands up the net that proves R1. `R2` is the perf wave (safe to defer).
`R3` borrows confetti's aerodynamics. `R4` is docs + demo.

---

## 5. The briefs

===============================================================================
# R0 -- lite-rain v1.0.1 -- node:test + the torture skeleton + metadata
===============================================================================

```markdown
---
package: "@zakkster/lite-rain"
version_target: 1.0.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [R-11, R-12, R-14, R-15]
blocks: [R1]
---

PURPOSE
  Port the tests to node:test, stand up the lite-bvh-shaped torture harness every
  later session leans on, and fix the metadata fossils. No behaviour change --
  the S1 bugs are made VISIBLE and REPRODUCIBLE here, fixed in R1.

TASKS
  - Port test/RainEngine.test.js (15 assertions) to node:test:
    `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`.
    `"test": "node --expose-gc --test test/*.test.js"`. Delete vitest.config.js
    and the vitest devDep. devDependencies -> lite-gc-profiler + lite-leak
    (match confetti: ^1.15.0 / ^1.8.1; verify latest before pinning).
  - Add CHANGELOG.md and a `VERSION` const exported from RainEngine.js; add both
    to files[]. Three-place version sync from here forward.
  - Verify lite-color v2.1.0 still exports `toCssOklch({l,c,h,a})`; bump the dep
    from `^1.0.5` to the verified current (`^2.1.0` unless 2.x broke the shape).
  - Strip the U+2B50 star from every source comment (R-15). Grep the file for
    non-ASCII before trusting it; the CLAUDE.md law excepts only U+00D7/U+00B5.
  - Build test/torture.mjs + test/torture/harness.mjs per section 3, cloning the
    lite-bvh harness surface (seeded PRNG, check-thunk, runOpsGate, die).
    Wire T0, T1, T6, T7, T9 now; register T3/T4/T5/T8 as empty tiers later
    sessions fill.
  - Register the R-01/R-02/R-13 reproductions in T3/T4 as `todo` failing cases
    with their exact repro (they FAIL today -- that is R1's job).

ASSERTIONS
  - `node --test` green, 15+ passing, 0 failing; grep proves no vitest remains.
  - `node --expose-gc test/torture.mjs` prints exactly "ok", exit 0.
  - T9 control (a `[]` allocation inside the T6 loop) and RAIN_TORTURE_BREAK=1
    each exit non-zero.
  - `npm pack --dry-run` excludes test/ and includes CHANGELOG.md.
  - Source is ASCII-only.

NON-GOALS
  No leak fix, no door, no new config. Findings recorded in CHANGELOG as known
  issues, fixed in R1.

DONE WHEN
  node:test green; torture "ok"; control fails; metadata current; R-01/R-02
  registered as failing/todo with reproductions
```

===============================================================================
# R1 -- lite-rain v1.1.0 -- correctness: the cull + the door
===============================================================================

```markdown
---
package: "@zakkster/lite-rain"
version_target: 1.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [R-01, R-02, R-03, R-13]
depends_on: [R0]
blocks: [R2]
---

PURPOSE
  Two S1 bugs, one class: the pool accepts states it can never leave. R-01 leaks
  drops that never fall; R-02 leaks drops poisoned to NaN. Both end with the same
  symptom -- the pool pins at `max` and the screen stops raining, silently. Plus
  the two contract gaps in the same neighbourhood (R-03 dt, R-13 constructor).
  This is the release headline and the reason rain is published-but-broken today.

WHY THESE TOGETHER
  They are one decision in four places: what does the engine do with a slot, a
  dt, a config value, or a capacity it cannot honour? The answer is the same --
  reject or recycle at the boundary, never accept-and-poison.

TASKS
  - **R-01 culling backport.** Cull a state-1 drop back to state 0 when it leaves
    the simulable region: `x < -200 || x > w + 200 || y < -200` (snow's 200px
    margins). Add it to the state-1 branch of updateAndDraw BEFORE the stroke
    pass so a culled drop is neither simulated nor drawn that frame. CHANGELOG the
    behaviour change: negative gravity / upward angle previously exhausted the
    pool silently; now those drops recycle.
  - **R-02 the door.** Validate config finiteness ONCE at construction (and on any
    documented setter): `gravity, wind, maxSpeed, blurStrength, splash*, angle
    (if non-null), density` must be finite; throw a library error naming the key
    if not. Copy the four-line finite predicate inline -- do NOT add a runtime
    dep. Reference the shared "broken value" contract lite-aabb/lite-bvh use.
  - **R-03 dt.** Clamp low as well as high: `if (!(dt > 0)) dt = 0;` (also rejects
    NaN dt) `else if (dt > 0.1) dt = 0.1;`, in BOTH spawn and updateAndDraw. A
    zero/negative/NaN frame is a no-op, not a reversed integrator.
  - **R-13 constructor.** `maxParticles` must be an integer `>= 1` and `<= a
    documented ceiling`; throw a library error, not a raw allocator RangeError.
  - Add `liveCount()` (or a `stats` getter) as O(max) test/debug telemetry so the
    conservation invariant is checkable without reaching into `state`.
  - Fill torture T3 (leak net) and T4 (constructor/config net) completely.

HOT PATH
  The cull is 3 comparisons in a branch drops already pass through -- measure it,
  it should be within noise. The door and the dt clamp are per-CALL, not
  per-particle: zero cost in the loop body. `assertOps` on updateAndDraw must be
  within noise of the v1.0.1 baseline; if the cull moves it, record the number.
  Config validation NEVER runs per particle.

ASSERTIONS
  - Failing-before/passing-after for each S1: `gravity:-1500`, 400 frames ->
    `liveCount()` bounded (was 500/500); `angle:-PI/2` -> bounded; `wind:20000`
    -> no live drop simulated past `w+200`.
  - Conservation invariant holds after every T3 adversarial run, AND a normal
    frame after each still recycles.
  - `new RainEngine(100,{gravity:NaN})` throws naming `gravity`; no path produces
    a NaN in the pool.
  - `updateAndDraw(ctx,-0.05,...)` and `dt:NaN` are no-ops (state unchanged).
  - `new RainEngine(0 | -1 | 2.5 | NaN | Infinity)` each throws a library error.
  - Fast-path `assertOps` within noise of v1.0.1 (or the delta recorded).
  - torture "ok"; T9 controls (cull disabled, door bypassed) fail.

NON-GOALS
  No ring cursor (R2). No index lists (R2). No new forces (R3). The spawn-window
  blowup R-04 is deferred to R2 -- it is overdraw, not corruption, once R-01's
  cull recycles the off-screen drops.

DONE WHEN
  every S1/S3 finding has a named failing-before/passing-after test; conservation
  holds under every T3 sequence; door rejects non-finite config; fast path
  measured unchanged
```

===============================================================================
# R2 -- lite-rain v1.2.0 -- the hot-path wave
===============================================================================

```markdown
---
package: "@zakkster/lite-rain"
version_target: 1.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [R-04, R-05, R-07, R-08, R-09, R-10]
depends_on: [R1]
blocks: [R3]
---

PURPOSE
  Rain does correct work inefficiently: it scans the whole pool to allocate
  (R-07), scans it 4x to render (R-08), re-reads config per particle (R-09),
  recomputes area per spawn (R-05), and over-spawns off-screen under wind (R-04).
  None corrupts; all cost frames. This is the polish release, gated by a bench.
  All six findings re-confirmed present against v1.1.0 on 2026-08-21 (dim cache
  still absent; spawn still O(max); render still scans the pool 4x; windOffset
  still unclamped for finite gravity; config still re-read per particle; splash
  constants still hardcoded).

R1 INTERACTIONS (the hot paths R2 rewrites now carry R1's cull + age cap -- do
not regress them):
  - **The binning pass runs INSIDE the state-1 physics loop, AFTER R1's
    cull/age-cap.** Order per drop: integrate -> `y>=h` splash -> else NaN-safe
    positional cull -> else age-cap (`(life-=dt)<=0`) -> else bin its index into
    the bucket list. A drop culled or aged-out this frame must NOT be binned or
    drawn. R-08 collects LIVE indices only; it never resurrects the 4x scan's
    "check state each pass" as an excuse to skip the cull.
  - **The ring cursor changes SLOT ASSIGNMENT, so the T8 snapshot re-baselines
    at R2** (see the corrected determinism assertion). Do not treat a byte-diff
    vs the v1.1.0 slot layout as a regression -- the *draw set* must be identical,
    the *slot indices* need not be.
  - **R-04 must not undo R1's `gravity:0` guard.** R1 already sets
    `windOffset = (g !== 0) ? (h/g)*|wind| : 0`. R2 clamps the non-zero branch to
    a sane multiple of `w`; keep the `g===0 -> 0` fallback intact.
  - **R-09 hoisting is safe because the R1 door froze config finiteness at
    construction.** Document that mutating `config` mid-run is unsupported (no
    re-validation on the hot path); a caller who must retune rebuilds or accepts
    that hoisted locals lag by up to a frame.

TASKS
  - **R-05 dimension cache.** `_lastW/_lastH/_areaModifier`; recompute only on a
    `(w,h)` change. Sets up gust work in R3.
  - **R-07 ring-cursor allocator.** Persist a `_spawnCursor`; scan from it and
    wrap, so low-occupancy spawn is O(spawned) amortized, not O(max). Keep
    correctness: a full pool still terminates the scan in one lap.
  - **R-08 single binning pass.** One pass over the pool fills three persistent
    per-bucket `Uint32Array` index lists (+ counts) and a splash index list; the
    render then walks only live indices, not `0..max` x4. Buffers allocated once
    at construction; assert they never grow (T6).
  - **R-09 hoist.** Lift `config.angle/maxSpeed/splashBounce/splashSpread/
    splashLife*` and derived constants to frame-top locals in updateAndDraw.
    Ledger any rejected hoist.
  - **R-10 splashScale.** Expose `splashScale` (default preserves `1.2 +
    abs(vy)/2000`); read once per frame, not per splash.
  - **R-04 spawn window.** Clamp the wind-driven spawn band to a sane multiple of
    `w` (e.g. `min(windOffset, w)` margins) so drops are born near-screen; the
    R-01 cull already recycles any that drift off. Document the interaction.
  - Fill torture T5 (fuzz vs oracle) and widen T6 with the direct buffer-length
    and byteLength asserts.

HOT PATH
  These ARE the hot path. Every change is measured, not assumed. Add a bench
  (build-once engine, N frames, report frame-time percentiles with a provenance
  stamp) and a VersionMatrix vs v1.1.0. Expect R-08 to show the biggest
  full-frame win at low occupancy.

ASSERTIONS
  - T6 passes at `maxArrayBuffersGrowth:0, stabilize:'deep'` over a 500k-op
    steady-state loop; the per-bucket index buffers and pool buffers do not grow
    (direct length/byteLength asserts).
  - DRAW SET is IDENTICAL to v1.1.0 across the T5 corpus -- the binning pass and
    ring cursor change iteration order and slot assignment, never WHICH drops are
    drawn or their pixels. Compare SORTED draw-call logs from the fake ctx
    (order-independent), NOT a position-by-position array diff.
  - Determinism is engine-vs-engine: two R2 engines with the same seeded `rng`
    produce byte-identical `x/y/vx/vy/state/life` snapshots. The ring cursor
    deliberately changes slot layout, so the T8 golden snapshot is RE-BASELINED at
    R2 (record the new baseline); it is NOT expected to byte-match v1.1.0's layout.
  - Bench: frame-time improvement recorded with provenance; <= 3% regression
    tolerated on any single metric only with a recorded justification.
  - torture "ok"; T9 control (an allocating render pass) fails.

NON-GOALS
  No new forces or features (R3). No format change to the 12-array pool.

DONE WHEN
  pool scanned once to allocate and once to render; zero-alloc gate green with
  direct buffer asserts; render fuzz-identical to v1.1.0; bench recorded
```

===============================================================================
# R3 -- lite-rain v1.3.0 -- aerodynamics + features (from lite-confetti)
===============================================================================

```markdown
---
package: "@zakkster/lite-rain"
version_target: 1.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: []
depends_on: [R2]
blocks: [R4]
---

PURPOSE
  Rain's force model is gravity + constant wind. Confetti's is a full weather
  system. Borrow its living-air forces and its depth-knob/speed-knob discipline
  -- copied logic, NO new dependency, every new knob default-off and
  fingerprint-safe.

BORROW FROM CONFETTI (copy, do not depend)
  - `gust` (Confetti 0009, v1.8.0): a GLOBAL sinusoidal horizontal acceleration
    layered on `wind` -- `vx += sin(_elapsed * GUST_HZ) * gust * dt`, guarded
    `if (gust !== 0)`, `GUST_HZ = TAU/3` (~3s swells). The whole rain sheet
    leans left then right in coherent waves. This is snow v1.3.0's gust done the
    confetti way.
  - `gustRate` (Confetti 0026, v1.25.0): the SPEED knob to gust's depth. Default
    is a fround sentinel `Math.fround(GUST_HZ)` = off; `0` freezes the phase to
    an inert `sin(0)=0`; negative reverses. Read INSIDE the `gust !== 0` guard so
    a gust-off sheet reproduces every pre-feature fingerprint bit-for-bit.
  Copy confetti's determinism contract wholesale: a single global `_elapsed`
  accumulator advanced once per frame, feature reads guarded, no per-particle
  state added for a global force. Drops are fast-lived, so `gust` modulates
  `wind` at frame top and per-drop `wz` stays fixed at spawn (respawn absorbs the
  change -- cheaper than per-particle recompute; note the reasoning in README).

TASKS
  - `gust` + `gustRate` config (both default off = zero cost, zero fingerprint
    change). Wire into the R2 hoisted wind term. T8 fingerprint: gust-off ==
    v1.2.0 snapshot bit-for-bit.
  - `RAIN_PRESETS` export (R-06) as `export const RAIN_PRESETS = {...}`, confetti
    style (spread into config): `drizzle`, `steady`, `downpour`, `storm` (storm =
    high wind + a slanted `angle` + a live `gust`). d.ts + README table.
  - **floorY** (parity with snow v1.1.0): splash line above canvas bottom for
    HUD-aware overlays; default `null` = use `h`. One clamp in the floor-hit test.
  - OPTIONAL, budgeted, default-off (each behind a `!== 0`/`false` guard, each
    counts against `max`, each documented):
      * `splashDroplets: 0..3` -- on impact spawn N micro-splashes from the same
        pool (state 2 with small per-particle radius; no new state).
      * `ripples: true` -- impacts register into a pre-allocated 64-slot ripple
        ring (x, r, life), rendered as stroked ellipses in one path/frame, fully
        independent of the particle pool.

HOT PATH
  Every new force is a guarded add (`if (knob !== 0)`) so an off configuration
  takes ZERO new instructions and reproduces the prior fingerprint. `_elapsed` is
  one global add per frame. Ripples are their own ring, never touching the pool
  loops. assertOps on the OFF path unchanged from v1.2.0.

ASSERTIONS
  - gust-off / gustRate-off / droplets-off / ripples-off: T8 snapshot IDENTICAL
    to v1.2.0; assertOps unchanged.
  - gust ON: the sheet's mean vx oscillates sign over `~2pi/GUST_HZ`; gustRate
    scales the period; gustRate `0` freezes it.
  - Each preset spreads into a valid config that passes the R1 door.
  - `floorY` splashes land on the line, not the canvas bottom.
  - Droplets/ripples respect `max` and the conservation invariant; T7 soak green
    with every feature ON.
  - torture "ok"; T9 control (a feature that mutates the pool while OFF) fails T8.

NON-GOALS
  Per-particle turbulence curl (confetti's `turbulence`) -- drops are too
  short-lived to read it; revisit only if a use case appears. No lightning /
  thunder (app-layer). No collision with arbitrary geometry (only floorY).

DONE WHEN
  gust + gustRate shipped and fingerprint-safe; presets + floorY landed; optional
  droplets/ripples default-off and budgeted; every OFF path bit-identical to
  v1.2.0
```

===============================================================================
# R4 -- lite-rain v1.4.0 -- integration + docs
===============================================================================

```markdown
---
package: "@zakkster/lite-rain"
version_target: 1.4.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: []
depends_on: [R3]
blocks: []
---

PURPOSE
  Make the corrected, fast, feature-complete engine legible: a demo that shows
  every preset and force, and a README rebuilt on the LiteSepforge blueprint
  spine (CLAUDE.md law).

TASKS
  - Demo (demo/demo.html): preset switcher, a slanted-storm scene using `angle` +
    `gust`, and a droplet/ripple stress scene with live frame-time readout.
  - README refresh to the LiteSepforge spine, in order: title + one-line
    blockquote; badges; "The rain engine the ecosystem was missing" positioning
    H2 with inline install + runnable quick-start; TOC; Why this exists; What you
    get; a <details> deep-dive on the pool + lifecycle; API reference (signatures
    + config constants table incl. the R3 knobs); Composability (full game-loop +
    a snow/confetti co-render); a <details> Zero-GC design notes with an
    allocation table + the gated torture numbers; Design decisions (the cull, the
    door, gust's per-frame-not-per-particle choice); Testing (assertion + tier
    counts, `npm test` / `npm run torture`); What this is not; Ecosystem; License.
  - Mermaid state diagram: free -> falling -> splash -> free, with the ripple
    side-track and the cull edge (falling -> free).
  - Regenerate llms.txt (new config keys, presets, torture surface).
  - Worker + OffscreenCanvas recipe in the README (inlined, since the referenced
    external recipe file R-14 does not exist).
  - Bench provenance table from R2/R3.
  - Grep the finished README and llms.txt for stray tool-call tags and non-ASCII
    before shipping (CLAUDE.md law).

ASSERTIONS
  - README follows the blueprint spine section-for-section; ASCII-only.
  - Every documented config key exists in RainEngine.js and the d.ts; every
    preset name resolves.
  - `npm pack --dry-run` ships README.md + llms.txt + CHANGELOG.md, not test/.
  - Demo runs every preset without a console error.

NON-GOALS
  No API change -- docs describe what R1-R3 shipped. No "drops on glass" screen
  effect (different domain; separate package if ever).

DONE WHEN
  demo covers presets + storm + ripples; README on the blueprint spine with gated
  numbers; llms.txt regenerated; docs ASCII-clean
```

---

## 6. Non-goals (whole package)

Screen-space "drops on glass" trickle (different problem domain). Lightning /
thunder orchestration (app-layer; engines stay single-purpose). Collision with
arbitrary geometry (only the `floorY` horizontal line). A runtime dependency on
lite-confetti or lite-snow -- their logic is BORROWED (copied), never imported;
rain keeps its single runtime dep (`lite-color`) and its zero-dep hot path.
