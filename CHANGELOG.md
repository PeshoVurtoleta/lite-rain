# Changelog

All notable changes to `@zakkster/lite-rain` are documented here.

## [1.2.0] - 2026-08-21

Performance / polish release. The internal work per frame is rewritten (single
binning pass, ring-cursor allocation, hoisted config, dimension cache) with the
DRAW SET held constant for R-05/R-07/R-08/R-09: the same drops are drawn with the
same pixels; only iteration order and slot assignment change. The one deliberate
visible change is R-04, which narrows the wind-driven spawn band so drops are
born near-screen instead of far off it (documented below). The R1 off-screen
cull, the 12s age cap, and the finite-config door are all intact.
Proven by the torture harness (`node --expose-gc test/torture.mjs` -> `ok`,
`alloc` ~0.09 B/op, `gc major=0`) and a build-once frame-time bench.

### Changed

- **Single binning pass (R-08).** `updateAndDraw` scanned the pool once to
  integrate physics, then FOUR more times to render (three streak buckets +
  splashes). It now bins each drop's index into one of three persistent per-bucket
  `Uint32Array` streak lists or a `Uint32Array` splash list DURING the single
  physics pass -- appended only AFTER the drop's transitions resolve and keyed on
  its FINAL state this frame. The render then walks ONLY the binned live indices,
  never `0..max` again. A drop culled or aged-out this frame is state 0 and is
  never binned or drawn (the R1 cull/age-cap order is preserved: integrate ->
  floor-splash -> positional cull -> age cap -> bin). The four index buffers are
  allocated once at construction and never grow (asserted directly by T6).
- **Ring-cursor allocator (R-07).** `spawn` scanned from index 0 every call. It
  now scans from a persisted `_spawnCursor` and wraps, bounded to exactly `max`
  probes so a FULL pool still terminates in one lap. Low-occupancy spawn is now
  O(spawned) amortized instead of O(max). **This changes SLOT ASSIGNMENT** -- the
  same drops with the same trajectories land in different slots. The draw set and
  every pixel are unchanged; only iteration order and slot indices differ.
- **Dimension cache (R-05).** `spawn` recomputes `areaModifier = (w*h)/100000`
  only when `(w, h)` changes, from cached `_lastW/_lastH/_areaModifier`.
- **Hoisted config reads (R-09).** `updateAndDraw` and `spawn` lift loop-invariant
  `config` reads (`angle`, `maxSpeed`, `splashBounce`, `splashSpread`,
  `splashLifeMin/Max`, `splashScale`, `rng`, `gravity`/`wind`) and derived
  constants (`cos`/`sin` of a fixed angle, the spawn window) to frame-top locals.
  This is safe because the R1 door froze config finiteness at construction:
  **mutating `config` mid-run is unsupported** -- the hoisted locals lag a live
  config edit by up to a frame; a caller who must retune rebuilds the engine.

### Added

- **`splashScale` config (R-10), default `1.2`.** Splash radius is
  `z * (splashScale + abs(vy)/2000)`; the default preserves the exact prior radius
  (the `1.2` base was hardcoded). Validated by the finite-config door and read once
  per frame, not per splash.
- **`bench/bench.mjs` + `npm run bench`.** Builds one engine, runs N frames at a
  fixed dt over a fake ctx, and reports frame-time p50/p90/p99 with a provenance
  stamp (node version, seed, max, density, frames, occupancy, canvas, dt). Not
  shipped (excluded from `files[]`; proven by `npm pack --dry-run`).

### Fixed

- **Unclamped wind spawn window (R-04).** The wind-driven spawn band was
  `windOffset = (g !== 0) ? (h/g)*|wind| : 0`, which under strong wind on weak
  gravity spawned drops arbitrarily far off-screen (pure overdraw -- the R1 cull
  recycled them the next frame, but only after wasting a spawn slot and an
  integration). The non-zero branch is now clamped to a sane multiple of `w`:
  `Math.min((h/g)*|wind|, w)`, so drops are born near-screen. **Interaction with
  R1:** the `g === 0 -> 0` fallback (R1's Infinity guard) is unchanged, and the R1
  positional cull still recycles any drop that drifts off after birth -- the clamp
  only stops the over-wide birth band, it does not replace the cull.

### Performance

Bench provenance: node `v26.3.1`, seed `2654435769`, `max=8000`, 20000 frames,
1920x1080, `dt=0.01667`. Frame-time percentiles (ms), v1.1.0 -> v1.2.0:

- Saturated pool (`density=30`, occupancy ~7900/8000):
  p50 `0.1798 -> 0.1168` (-35%), p90 `0.1923 -> 0.1258` (-35%),
  p99 `0.2537 -> 0.1457` (-43%).
- Low occupancy (`density=2`, occupancy ~3200/8000):
  p50 `0.0772 -> 0.0435` (-44%), p90 `0.0821 -> 0.0475` (-42%),
  p99 `0.1637 -> 0.0565` (-65%). The binning pass shows the biggest full-frame win
  at low occupancy, where the old 4x render scan walked the empty pool tail.

No metric regressed. (Occupancy shifts by a handful of drops because the ring
cursor and the R-04 clamp change slot layout and the birth band; the draw set is
proven identical to a full-scan render of the same pool by torture tier T5.)

### Testing

- **Torture T5 (fuzz vs oracle) filled.** A seeded mixed spawn/update/clear corpus
  across six force fields runs against an independent scan oracle (every live drop
  finite and on a plausible trajectory). A DRAW-SET-IDENTICAL check logs the
  engine's binned draw calls and asserts the SORTED multiset equals a reference
  full-scan render of the same committed pool -- the binning pass and ring cursor
  change iteration order and slot assignment, never WHICH drops are drawn.
- **Torture T6 widened.** Alongside the heap gate over a 500k-op steady state, the
  three streak index buffers and the splash index buffer now have direct
  `length` + `byteLength` before/after asserts (ArrayBuffer backing stores are
  invisible to a heapUsed gate).
- **Torture T8 re-baselined engine-vs-engine.** Two R2 engines fed the same seeded
  rng produce byte-identical `x/y/vx/vy/state/life` snapshots. The ring cursor
  deliberately changes slot layout, so the golden is NOT expected to match the
  v1.1.0 position-by-position layout.
- **T9 control added.** A forged binned render that draws a culled (state 0) drop
  must fail the T5 draw-set comparison -- proving that gate can bite.

## [1.1.0] - 2026-08-21

Correctness release. Two silent-corruption bugs (S1) and two contract gaps (S3)
are fixed. The particle pool now recycles every drop it can no longer simulate,
and rejects poison at the door instead of exhausting itself three frames later.

### Fixed

- **Unbounded pool leak (R-01).** State-1 drops were only ever recycled by
  reaching the floor (`y >= h`). Any force keeping a drop from the floor leaked
  it forever, pinning the pool at `max` and silently blanking the screen.
  `updateAndDraw` now culls a state-1 drop back to free (state 0) when it leaves
  the simulable region -- `x < -200 || x > w + 200 || y < -200` (the same 200px
  margins lite-snow uses). The cull runs AFTER position integration
  (a floor hit takes precedence) and uses a NaN-safe negated-range test
  (`!(x >= -200 && x <= w + 200 && y >= -200)`), so a drop that integrates
  off-screen -- or a drop carrying a non-finite coordinate -- is recycled rather
  than left live. The render pass is a separate `state === 1` loop, so a culled
  drop is never drawn.
  **Behaviour change:** negative gravity, an upward `angle` (e.g. `-PI/2`), and
  extreme `wind` previously exhausted the pool silently; those drops now recycle.
  `spawn` also guards its derived spawn window: a finite `gravity` of `0` made
  `h / gravity` Infinity and poisoned spawn coordinates to NaN; it now falls back
  to a zero wind-offset (drops spawn on-screen, finite, and recycle). Full
  on-screen spawn-window sizing under `gravity: 0` / weak gravity is R-04 (v1.2.0).
  The positional cull alone still missed a drop FROZEN inside the box with zero
  net motion (`gravity:0 + wind:0`; `angle:0` with gravity-derived speed 0;
  `maxSpeed:0 + wind:0` -- all finite, all accepted by the door): it never leaves,
  never falls, never recycles. A bounded state-1 age cap now backs the positional
  cull -- each falling drop carries a time-aloft budget of `MAX_FALL_LIFE = 12s`
  (reusing the otherwise-idle `life` array; the splash transition overwrites it, so
  no clash) and is recycled when the budget runs out. 12s is far beyond a normal
  fall (a far-depth drop under default gravity reaches the floor in ~2-3s, up to
  ~5s on a 2160p canvas), so it
  never touches a real raindrop; it is the guarantee that bounds the pool under ANY
  finite force field. Not a config knob in this release.
- **Open NaN door (R-02).** A single non-finite config value poisoned `x/y/vy`
  to NaN on frame 1 for every drop; since `NaN >= h` is false, poisoned drops
  never recycled -- one bad value permanently exhausted the pool and blanked the
  screen. The constructor now validates `gravity, wind, maxSpeed, blurStrength,
  splashBounce, splashSpread, splashLifeMin, splashLifeMax, density` (and `angle`
  when non-null) for finiteness and throws a `RangeError` naming the offending
  key. Non-finite / non-positive `w`/`h` passed to `spawn`/`updateAndDraw` are a
  documented no-op rather than a source of NaN coordinates.
- **`dt` clamped low as well as high (R-03).** Previously `dt` was clamped high
  (`> 0.1`) but not low, so a negative `dt` ran the integrator backward (drops
  rose, velocities inverted) and a NaN `dt` poisoned the pool. Both `spawn` and
  `updateAndDraw` now treat a zero / negative / NaN `dt` as a no-op step
  (`if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;`).
- **Constructor validation (R-13).** `new RainEngine(0)` built a silent no-op
  engine, `new RainEngine(2.5)` truncated the pool, and `new RainEngine(-1)`
  threw a raw allocator error. `maxParticles` must now be an integer in
  `[1, MAX_PARTICLES]` (`MAX_PARTICLES = 2_000_000`); anything else throws a
  clear `RangeError`.

### Added

- `liveCount()` -- O(max) count of live particles (`state != 0`) as test/debug
  telemetry for the pool-conservation invariant. Not for a hot path.
- `export const VERSION` and `export const MAX_PARTICLES`.
- Ported the test suite from vitest to `node:test`; added a lite-bvh-shaped
  torture harness (`test/torture.mjs`) gating conservation, the NaN/degenerate
  door, constructor/config abuse, a soak cycle, and a zero-alloc hot loop with
  `@zakkster/lite-gc-profiler` / `@zakkster/lite-leak`.

### Changed

- Bumped `@zakkster/lite-color` from `^1.0.5` to `^2.1.0` (verified
  `toCssOklch({l,c,h,a})` shape is unchanged).
- Source is now ASCII-only (removed U+2B50 stars from `// FIX N` comments).

## [1.0.0]

- Initial release: zero-GC SoA rain engine with Z-depth parallax, streak
  physics, splash metamorphosis, terminal velocity bounds, and bucketed
  rendering.
