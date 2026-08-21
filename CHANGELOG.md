# Changelog

All notable changes to `@zakkster/lite-rain` are documented here.

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
