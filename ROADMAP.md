# ROADMAP-LITE-RAIN-2026-07 — @zakkster/lite-rain

**Current:** v1.0.0 (npm = HEAD) · 7.2 KB single-file ESM · dep: `lite-color` · devDep: vitest (to be removed)
**Verdict from audit:** solid core (terminal velocity, precomputed `tailMult`, bucketed streaks are all good), but rain missed the fix wave snow received — it has a real particle-leak defect, no dimension cache, and no presets. v1.1.0 is a correctness release, not a polish release.

Shared recipes referenced below (A–I) live in `ROADMAP-FX-REVIVAL-2026-07.md`.

---

## Audit findings ledger

**F1 — Particle pool leak: no off-screen culling for falling drops (severity: high).** Snow's own source comments document culling "X-axis wind leak AND Y-axis negative gravity leak" — rain never got the backport. A state-1 drop is only ever recycled by reaching `y >= h`. Consequences: (a) negative `gravity`, or an upward `angle`, produces drops that rise forever and permanently exhaust the pool; (b) extreme wind blows drops far past the right edge where they are simulated and stroked invisibly until they happen to fall to `h`. Fix: cull state 1 at `x < -200 || x > w + 200 || y < -200`, same margins as snow. The W2 soak test (Recipe C) is the regression net that would have caught this.

**F2 — No dimension cache.** `areaModifier = (w * h) / 100000` recomputed every `spawn` call; snow caches on (w, h) change. Trivial cost, but backport for convention parity (Recipe G) — and it sets up gust work later.

**F3 — No `RAIN_PRESETS`.** Snow ships three presets; rain ships none, so every consumer re-derives tuning. Add `drizzle` / `steady` / `downpour` / `storm` (storm = high wind + a non-null slanted `angle` reference in docs).

**F4 — O(max) free-slot scan** (same as all five). Recipe D ring cursor.

**F5 — Render pass scans full pool 4×** (three streak buckets + splash pass over all `max` slots). Same fix as snow F3: persistent per-bucket `Uint32Array` index lists + counts from a single binning pass; splash indices collected in the same pass.

**F6 — Loop-invariant property loads in hot bodies.** Recipe E hoisting.

**F7 — Splash magic constants.** Splash radius `z * (1.2 + |vy| / 2000)` hardcodes impact scaling; splashes also skip X culling (cosmetic only — they die by life). Expose `splashScale` (default preserves 1.2/2000 behavior) while touching the branch.

**F8 — Metadata.** `"webgl"` keyword inaccurate; no CHANGELOG; `lite-color` `^1.0.5` → `^1.1.0`; vitest devDep. (Recipe I.)

**F9 — Test gaps.** No leak/soak coverage (which is why F1 survived), no `--expose-gc` proof, no determinism snapshot, no dt/dimension abuse. (Recipes B, C.)

---

## v1.1.0 — Correctness + node:test *(target: session S2)*

- **F1: culling backport** — the release headline. Add the state-1 bounds cull with snow's 200 px margins; document the negative-gravity/upward-angle behavior change in CHANGELOG (previously: silent pool exhaustion; now: recycled).
- F2: dimension cache backport (`_lastW/_lastH/_areaModifier`).
- F3: `RAIN_PRESETS` export (`drizzle`, `steady`, `downpour`, `storm`) + d.ts entry + README table.
- Migrate `RainEngine.test.js` to `node:test` per Recipe A; delete `vitest.config.js`; devDependencies to zero; `"test": "node --test"`.
- Add a targeted leak regression test now (don't wait for W2): negative gravity, 600 frames, assert live count returns to ~spawn-rate steady state.
- F8: keyword cleanup, CHANGELOG.md, `lite-color` `^1.1.0`.
- Gate: suite green on M4 + Intel.

## v1.2.0 — Hot-path wave *(sessions S6–S7, shared W2)*

- F4: ring-cursor allocator (Recipe D).
- F5: bucket index lists + single binning pass.
- F6: hot-body hoisting (Recipe E), rejections ledgered.
- F7: `splashScale` config exposure.
- Recipe B zero-GC suite (streak + splash branches), Recipe C torture suite (soak, seeded determinism snapshot over `x/y/vx/vy/state`).
- Recipe F bench harness + VersionMatrix vs v1.1.0; ≤ 3 % Intel gate. Expect F5 to show the biggest full-frame win at low occupancy.
- SPP probes: `rain.spawn`, `rain.physics`, `rain.render`.

## v1.3.0 — Features *(session S8, shared gust work with snow)*

- **Wind gusts.** Same 1D value-noise pattern as snow v1.3.0 (copied implementation, no new dep): gusts modulate `wind` at frame top; per-drop `wz` stays fixed at spawn (drops are fast-lived, respawn absorbs the change — cheaper than per-particle recompute; note this reasoning in README). Config `gustStrength` default 0 = zero cost.
- **Splash crown droplets (optional).** `splashDroplets: 0..3` (default 0): on impact, spawn N micro-droplets from the same pool with short life, using existing state 2 with per-particle radius — no new state needed if droplets are just small splashes with velocity. Budgeted: droplets count against `max`, documented.
- **Puddle ripples (optional).** `ripples: true`: impact registers into a small pre-allocated ripple ring (x, r, life; 64 slots), rendered as stroked ellipses in one path per frame. Fully independent of the particle pool.
- **`floorY` config** (parity with snow v1.1.0): rain line above canvas bottom for HUD-aware overlays.

## v1.4.0 — Integration + docs *(session S10)*

- Oscilloscope-blueprint demo: preset scenes, slanted-storm scene (`angle`), ripple/droplet stress scene with SPP readouts.
- Worker + OffscreenCanvas README recipe (Recipe H).
- README refresh: Mermaid state diagram (falling → splash → idle, ripple side-track), llms.txt regeneration, bench provenance table.

## Non-goals

Screen-space "drops on glass" trickle effect (different problem domain — separate package if ever), lightning/thunder orchestration (app-layer concern; engines stay single-purpose), collision with arbitrary geometry (only the `floorY` horizontal line).
