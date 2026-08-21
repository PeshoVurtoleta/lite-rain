# Changelog

All notable changes to `@zakkster/lite-color` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [2.1.0] - 2026-07-30

### Added

- **`isInSrgb(color): boolean`** — is an OKLCH color displayable in sRGB without
  clipping? Tests the raw linear-light R/G/B against `[0,1]` (the sRGB transfer is
  monotonic there, so the check is exact and skips the transfer). Alpha is
  ignored; the boundary counts as in-gamut. Zero allocation.
- **`clampToSrgb(color, out?): { l, c, h, a }`** — pull an out-of-gamut color into
  sRGB by reducing **chroma only**, preserving hue and lightness. Fixed 18-iteration
  chroma bisection (bounded cost; boundary resolved to ~1.5e-6). An in-gamut color
  is copied through unchanged; alpha passes through; a missing `a` defaults to `1`.
  Pass `out` for zero-allocation reuse.

### Notes

- Additive and fully backward compatible — no API or LUT-layout change from 2.0.0.
- **Scope boundary.** This is the sRGB-only, zero-dep hot-path pair. Tiered
  classification (`srgb`/`p3`/`out`), palette-wide audits, and Display-P3 live in
  [`@zakkster/lite-hueforge`](https://www.npmjs.com/package/@zakkster/lite-hueforge)
  (`gamutOf` / `auditGamut`) — same algorithm shape, deliberately not a dependency.
- Out-of-range lightness (`l` outside `[0,1]`) is clamped into range before
  clamping chroma: no chroma can rescue an out-of-range `L`, and the function
  must not return a still-clipping color. See `decisions/0003-gamut-lite.md`.
- Internally, the OKLCH -> linear-sRGB matrix was factored into a shared
  `oklchToLinear` helper feeding both the RGB bridges and the gamut checks; the
  `toRgbTo` / `toRgbBytesTo` output is unchanged.

## [2.0.0] - 2026-07-30

### BREAKING

- **`bakeGradient` LUT stride is now 4 floats per stop (`l, c, h, a`), up from 3.**
  The packed `Float32Array` grew to carry alpha. Index a stop by
  `base = i * BAKE_STRIDE` (`BAKE_STRIDE === 4`), read `a` at `base + 3`, and
  size any caller-owned `out` as `steps * BAKE_STRIDE`.

  | Before (v1.x, stride 3) | After (v2.0, stride 4) |
  | --- | --- |
  | `const l = lut[i * 3]` | `const l = lut[i * BAKE_STRIDE]` |
  | `const c = lut[i * 3 + 1]` | `const c = lut[i * BAKE_STRIDE + 1]` |
  | `const h = lut[i * 3 + 2]` | `const h = lut[i * BAKE_STRIDE + 2]` |
  | *(no alpha)* | `const a = lut[i * BAKE_STRIDE + 3]` |
  | `new Float32Array(steps * 3)` | `new Float32Array(steps * BAKE_STRIDE)` |

  `bakeCssGradient` is **not** affected — it returns strings, and now simply
  includes the interpolated alpha in each `oklch(... / a)`.

### Added

- **Alpha threaded end to end.** `lerpOklch`, `lerpOklchTo`,
  `multiStopGradientTo`, `bakeGradient` and `bakeCssGradient` now carry `a`.
  A missing `a` on either input defaults to `1` (opaque) per CSS Color 4; alpha
  interpolates linearly and is clamped to `[0,1]`.
- **`BAKE_STRIDE`** constant (`4`) — index LUTs by this, not a literal.
- **Full CSS Color 4 `oklch()` grammar** in `parseOklch`: number and percentage
  channels (L%/A% -> 0-1, **C% -> 0-0.4**), `none` channels, `deg`/`rad`/`grad`/
  `turn` hue units, the `/ alpha` slash form (number or percentage), leading-dot
  numbers, case-insensitivity, and flexible whitespace.

### Changed

- `parseOklch` now **throws** on malformed input with a `cannot parse` message
  (it already did on the previous narrow grammar; the guarantee is now documented
  and tested). Rationale: fail at config time, not while rendering.
- `parseOklch` return type is `Required<OklchColor>` — `a` is always defined.

### Notes

- Omitted alpha parses to `1`; an explicit `/ none` parses to `0`. `none` on any
  channel parses to `0` (the full CSS "powerless component" interpolation is a
  documented non-goal).
- Recorded tradeoff: threading alpha adds ~2 ops to `lerpOklch`'s hot body, so
  its throughput is intentionally not identical to v1.x.
- Rationale and rejected alternatives in `decisions/0002-alpha-and-grammar.md`.

## [1.1.1] - 2026-07-30

### Fixed
- **Install-order failure under pnpm / Yarn Classic.** `Color.js` did a
  top-level `import { lerp, lerpAngle, clamp } from '@zakkster/lite-lerp'` that
  was declared only in `peerDependencies`. Package managers that do not
  auto-install peers left the import unresolved, so `import '@zakkster/lite-color'`
  threw `ERR_MODULE_NOT_FOUND` before any function ran — while the README
  advertised "Zero dependencies".

### Changed
- The three interpolation primitives (`lerp`, `lerpAngle`, `clamp`, plus the
  `wrap` helper `lerpAngle` uses) are now vendored **byte-identical** from
  `@zakkster/lite-lerp` as module-local functions. lite-lerp remains the source
  of truth; the exported hot-path bodies are textually unchanged, so `lerpOklch`
  throughput is unchanged.
- Removed `peerDependencies`. The package now has **zero runtime dependencies**,
  making the comparison-table claim true.
- README and `llms.txt` updated: `@zakkster/lite-lerp` is now documented as an
  optional companion for the easing helpers, not a requirement.

### Notes
- No public API change. `Color.d.ts` is unchanged.
- Rationale recorded in `decisions/0001-inline-lerp-primitives.md`.

## [1.1.0] - 2026-07-15

### Added
- `bakeGradient(colors, steps, out?, ease?)` — bake a multi-stop gradient into a
  packed `Float32Array` LUT of pre-evaluated OKLCH stops (3 floats per stop).
  Pass a reusable `out` to re-bake with zero allocations.
- `bakeCssGradient(colors, steps, ease?)` — bake a gradient into an array of
  pre-formatted CSS `oklch()` strings; format the palette once at setup.
- `toRgbTo(color, out, offset?)` — zero-GC OKLCH -> normalized sRGB RGBA (0-1)
  written into a caller-owned buffer. Bridge to WebGL / lite-gl RGBA fields.
- `toRgbBytesTo(color, out, offset?)` — zero-GC OKLCH -> sRGB bytes (0-255)
  written into a caller-owned buffer. Bridge to canvas `ImageData`.

## [1.0.0] - 2026-07-05

### Added
- Initial release: OKLCH color interpolation for games and gradients.
- `lerpOklch` / `lerpOklchTo` (zero-GC), `toCssOklch`, `parseOklch`.
- `multiStopGradient` / `multiStopGradientTo`, `createGradient`,
  `reverseGradient`, `randomFromGradient`.

[2.0.0]: https://github.com/PeshoVurtoleta/lite-color/releases/tag/v2.0.0
[1.1.1]: https://github.com/PeshoVurtoleta/lite-color/releases/tag/v1.1.1
[1.1.0]: https://github.com/PeshoVurtoleta/lite-color/releases/tag/v1.1.0
[1.0.0]: https://github.com/PeshoVurtoleta/lite-color/releases/tag/v1.0.0
