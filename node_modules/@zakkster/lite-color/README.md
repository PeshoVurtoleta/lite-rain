# @zakkster/lite-color

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-color.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-color)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-color?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-color)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-color?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-color)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-color?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-color)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

OKLCH color interpolation, multi-stop gradients, LUT baking, and CSS formatting for games and animations.

**The color space the web is moving to — with the interpolation tools it's missing.**

## Why This Library?

HSL interpolation produces muddy grays between saturated colors. RGB is worse. OKLCH is **perceptually uniform** — the midpoint between red and blue actually looks like a midpoint, not a desaturated mess.

- **OKLCH = modern, perceptual, beautiful** — the color space recommended by the CSS Color Level 4 spec
- **No muddy midpoints** — smooth gradients that look intentional, not accidental
- **Shortest-path hue** — interpolates around the color wheel the smart way (red → blue goes through purple, not through yellow)
- **Multi-stop gradients** — evaluate N-color gradients at any point with one function call
- **Factory pattern** — `createGradient()` returns a reusable sampler, zero allocations in hot loops
- **Round-trip CSS** — `toCssOklch()` and `parseOklch()` for seamless DOM integration
- **Works with any RNG** — `randomFromGradient()` accepts anything with `.next()`

- **Pre-baked LUTs** — `bakeGradient()` / `bakeCssGradient()` evaluate the gradient once at setup, index it per frame
- **RGB bridges** — `toRgbTo()` / `toRgbBytesTo()` write straight into WebGL buffers and canvas `ImageData`, zero allocations
- **sRGB gamut lite** — `isInSrgb()` tells you if a color clips; `clampToSrgb()` pulls it back in by chroma alone, preserving hue and lightness (v2.1.0)

Zero runtime dependencies. (`@zakkster/lite-lerp` is an optional companion for the easing helpers shown below, not a requirement.)

## Ecosystem Positioning

`@zakkster/lite-color` stays the **<1KB hot-path interpolation core** — tree-shakeable, so a real import costs 416–924 B gzipped ([sizes](#bundle-size-minified--gzipped)).

| Package | Owns |
|---------|------|
| **`@zakkster/lite-color`** | OKLCH lerp, multi-stop gradients, CSS round-tripping, `*To` zero-GC variants, LUT baking, RGB bridges, sRGB gamut clamp |
| **`@zakkster/lite-hueforge`** | Palette science, harmony generation, color theory primitives, tiered gamut classification (sRGB/P3/out), Display-P3, dithering |
| **`@zakkster/lite-color-engine`** | Design systems, tokens, variants, theme engines, high-level color architecture |

The split is explicit so the three packages never cannibalize each other's pitch. Reach for `lite-color` for fast per-frame color math, `lite-hueforge` for palette generation, `lite-color-engine` to build a production design system.

**Gamut, specifically.** `lite-color` owns the sRGB-only hot-path pair: `isInSrgb()` (does this clip?) and `clampToSrgb()` (fit it, chroma-only). `lite-hueforge` owns the palette-science side: **tiered** classification via `gamutOf()` (`'srgb' | 'p3' | 'out'`), palette-wide `auditGamut()`, Display-P3 end-to-end, and dithering. They share the hue-preserving chroma-bisection *shape* but not code — `lite-color` takes no dependency on `lite-hueforge`.

## Installation

```bash
npm install @zakkster/lite-color
```

The core has no runtime dependencies. The easing functions used in some examples
below (`easeInOut`, `easeIn`, `easeOut`) live in `@zakkster/lite-lerp` — install
it too if you want them: `npm install @zakkster/lite-lerp`.

## Quick Start

```javascript
import { lerpOklch, toCssOklch, createGradient } from '@zakkster/lite-color';
import { easeInOut } from '@zakkster/lite-lerp';

const fire = { l: 0.7, c: 0.25, h: 30 };
const ice  = { l: 0.8, c: 0.15, h: 230 };

// Simple interpolation
const mid = lerpOklch(fire, ice, 0.5);
element.style.color = toCssOklch(mid);

// Reusable gradient sampler (hot-path friendly)
const heatmap = createGradient([cold, warm, hot], easeInOut);
ctx.fillStyle = toCssOklch(heatmap(temperature));
```

## Benchmarks & Comparison

### Micro‑Benchmarks (Chrome M1, 2026)
| Operation              | Ops/sec |
|------------------------|---------|
| `lerpOklch()`          | ~120M   |
| `multiStopGradient()`  | ~90M    |
| `toCssOklch()`         | ~80M    |

### Bundle Size (minified + gzipped)

`sideEffects: false` — you only pay for what you import.

| Import | Size |
|--------|------|
| `lerpOklchTo`, `multiStopGradientTo`, `toCssOklch` (typical hot path) | **416 B** |
| Full interpolation core (everything from v1.0.x) | **656 B** |
| `toRgbBytesTo` (canvas ImageData) | **473 B** |
| `bakeCssGradient` (the confetti pattern) | **566 B** |
| `bakeGradient` + `toRgbTo` (particle setup) | **924 B** |
| Entire package surface | 1.37 KB |

The `<1KB` promise is a **per-import** promise, and v1.1.0 keeps it: every realistic import path is still under a kilobyte. The bundlephobia badge reports the full surface, which nobody imports.

### Comparison
| Feature | lite‑color | HSL | RGB | chroma.js | d3-color |
|---------|------------|-----|-----|-----------|----------|
| Perceptual uniformity | ✔ | ✘ | ✘ | ✔ | ✔ |
| Shortest‑path hue | ✔ | ✘ | ✘ | ✔ | ✔ |
| Zero dependencies | ✔ | ✔ | ✔ | ✘ | ✘ |
| <1KB tree‑shaken | ✔ | ✔ | ✔ | ✘ | ✘ |
| Hot‑path friendly | ✔ | ✘ | ✘ | ✘ | ✘ |
| Multi‑stop gradients | ✔ | ✘ | ✘ | ✔ | ✔ |


## API Reference

| Function | Description |
|----------|-------------|
| `lerpOklch(a, b, t)` | Interpolate two OKLCH colors. Clamps L, prevents negative C, shortest-path H. |
| `lerpOklchTo(a, b, t, out)` | Zero-GC variant of lerpOklch. Writes directly into a caller-owned output object. |
| `toCssOklch(color)` | Format to CSS: `oklch(0.7000 0.1500 120.00 / 1)` |
| `parseOklch(str)` | Parse CSS `oklch()` string back to `{ l, c, h, a }` |
| `multiStopGradient(colors, t, ease?)` | Evaluate a multi-stop gradient at position t |
| `multiStopGradientTo(colors, t, out, ease?)` | Same as multiStopGradient, Zero-GC |
| `createGradient(colors, ease?)` | Factory: returns a `(t) => color` sampler function |
| `reverseGradient(colors)` | Reverse without mutation |
| `randomFromGradient(colors, rng)` | Random sample using any RNG with `.next()` |
| `bakeGradient(colors, steps, out?, ease?)` | Bake a gradient into a packed `Float32Array` LUT (`BAKE_STRIDE` = 4 floats/stop: l, c, h, a) |
| `bakeCssGradient(colors, steps, ease?)` | Bake a gradient into pre-formatted CSS `oklch()` strings |
| `toRgbTo(color, out, offset?)` | Zero-GC OKLCH → normalized sRGB RGBA (0–1) |
| `toRgbBytesTo(color, out, offset?)` | Zero-GC OKLCH → sRGB bytes (0–255), ImageData-ready |
| `isInSrgb(color)` | `true` if the color is displayable in sRGB without clipping (boundary counts as in) |
| `clampToSrgb(color, out?)` | Fit an out-of-gamut color into sRGB by reducing chroma only; preserves L and h. Zero-GC with `out` |

## Recipes

### Pre-Baked LUTs & Zero-GC RGB Output (v1.1.0)

Evaluate once at setup. Sample millions of times per second with zero allocations.

```javascript
import { bakeGradient, bakeCssGradient, toRgbTo, toRgbBytesTo, BAKE_STRIDE } from '@zakkster/lite-color';

const LUT_STEPS = 128;              // power of two — lets us index with a bitmask
const LUT_MASK  = LUT_STEPS - 1;

// 1. Numeric OKLCH LUT — LUT_STEPS * BAKE_STRIDE (512) floats, one allocation, at setup
const $lut = bakeGradient([dark, mid, bright], LUT_STEPS);

// Per frame: pure indexing, no lerp, no allocations. Stride is 4: l, c, h, a.
const i = (((t * LUT_MASK) | 0) & LUT_MASK) * BAKE_STRIDE;
$color.l = $lut[i];
$color.c = $lut[i + 1];
$color.h = $lut[i + 2];
$color.a = $lut[i + 3];            // v2.0.0: alpha is baked in

// 2. Straight into a WebGL / lite-gl RGBA field, or canvas ImageData
toRgbTo($color, $instanceRgba, particleIndex * 4);              // 0–1 floats
toRgbBytesTo($color, $imageData.data, pixelIndex * 4);          // 0–255 bytes

// 3. Pre-formatted CSS strings — the lite-confetti pattern, now first-class
const $css = bakeCssGradient([cold, warm, hot], 64);
// render loop:
ctx.fillStyle = $css[(t * 63) | 0];   // never toCssOklch() per frame
```

`bake*` accepts the same optional `ease` as `multiStopGradient`, so a baked LUT matches its live sampler exactly:

```javascript
import { easeInOut } from '@zakkster/lite-lerp';

const sampler = createGradient([cold, hot], easeInOut);
const baked   = bakeGradient([cold, hot], 256, undefined, easeInOut);  // same curve
```

Pass a reusable `out` buffer to re-bake (e.g. on a theme change) with zero allocations:

```javascript
const $lut = new Float32Array(LUT_STEPS * BAKE_STRIDE);
bakeGradient(nextTheme, LUT_STEPS, $lut);   // no allocation, ever
```

**Notes**
- `bake*` is setup-time by design. Never call it per frame.
- **v2.0.0:** the LUT stride is `BAKE_STRIDE` (4 floats/stop: `l, c, h, a`), up from 3. Alpha is now interpolated end to end — a missing `a` on a stop is treated as `1` (opaque). Index by `i * BAKE_STRIDE`, not `i * 3`. `toRgb*` still reads `color.a ?? 1`.
- Out-of-gamut OKLCH is clipped to the sRGB cube by `toRgb*` — the safe, expected behavior for canvas and WebGL. To *fit* a color into gamut instead of hard-clipping it, use `clampToSrgb()` (below). For tiered classification and Display-P3, use `@zakkster/lite-hueforge`.

### sRGB Gamut Clamping (v2.1.0)

OKLCH lets you name colors that no sRGB display can show. `toRgb*` hard-clips
those (fast and safe for pixels), but hard-clipping shifts hue and flattens
detail. `clampToSrgb()` instead pulls the color back along **chroma only**,
keeping hue and lightness exact — the perceptually honest fix — then hands you a
color every downstream function already understands:

```javascript
import { isInSrgb, clampToSrgb, toCssOklch } from '@zakkster/lite-color';

const vivid = { l: 0.7, c: 0.37, h: 145 };   // more chroma than sRGB can show

isInSrgb(vivid);                              // false -- it would clip

// Zero-GC: reuse one object across the whole palette.
const $safe = { l: 0, c: 0, h: 0, a: 1 };
clampToSrgb(vivid, $safe);                    // same L and h, chroma reduced to fit
isInSrgb($safe);                              // true
element.style.color = toCssOklch($safe);
```

- Preserves `l` and `h`; moves `c` only. An already-in-gamut color passes through
  untouched. A missing `a` defaults to `1`; an explicit `a` passes through.
- Fixed 18-iteration chroma bisection — bounded, predictable cost, boundary
  resolved to ~`1.5e-6`. No unbounded loops.
- Zero allocation when you pass `out`. `isInSrgb` never allocates.

### Multi-Stop Heatmap

Five stops, one line to sample. Perfect for data visualization, terrain mapping, or damage indicators:

```javascript
const heatmap = createGradient([
    { l: 0.9, c: 0.10, h: 260 },  // cool blue
    { l: 0.8, c: 0.20, h: 120 },  // green
    { l: 0.7, c: 0.30, h: 40 },   // yellow
    { l: 0.8, c: 0.25, h: 20 },   // orange
    { l: 0.9, c: 0.30, h: 0 },    // red hot
]);

// In your render loop — zero allocations
ctx.fillStyle = toCssOklch(heatmap(normalizedValue));
```

### Color Pulsing Animation

Smooth oscillation between two colors using a sine wave:

```javascript
function animate(time) {
    const t = (Math.sin(time * 2) + 1) / 2;  // 0 → 1 → 0 → ...
    element.style.color = toCssOklch(lerpOklch(gold, white, t));
    requestAnimationFrame(animate);
}
```

### Day/Night Sky Cycle

Four-stop gradient driven by game time:

```javascript
const dawn  = { l: 0.7, c: 0.12, h: 50 };
const noon  = { l: 0.9, c: 0.05, h: 230 };
const dusk  = { l: 0.5, c: 0.18, h: 20 };
const night = { l: 0.15, c: 0.08, h: 270 };

const sky = createGradient([dawn, noon, dusk, night]);

function updateSky(timeOfDay) {
    // timeOfDay: 0 = dawn, 0.33 = noon, 0.66 = dusk, 1 = night
    canvas.style.background = toCssOklch(sky(timeOfDay));
}
```

### Particle Color Over Life

Combine with `lite-particles` — particles born white, die ember red:

```javascript
const birth = { l: 0.95, c: 0.05, h: 60 };   // bright white-yellow
const death = { l: 0.4, c: 0.25, h: 15 };     // deep ember

emitter.draw(ctx, (ctx, p, life) => {
    const color = lerpOklch(death, birth, life);  // life: 1→0
    ctx.fillStyle = toCssOklch(color);
    ctx.globalAlpha = life;
    ctx.fillRect(p.x, p.y, p.size, p.size);
});
```

### Random Color from Gradient

Generate varied but harmonious colors for spawned objects — works with `@zakkster/lite-random`:

```javascript
import { Random } from '@zakkster/lite-random';

const palette = [
    { l: 0.7, c: 0.2, h: 30 },   // warm
    { l: 0.6, c: 0.25, h: 330 },  // magenta
    { l: 0.8, c: 0.15, h: 200 },  // sky
];

const rng = new Random(42);
const color = randomFromGradient(palette, rng);
```

### Eased Gradient Transitions

Pair with any easing function from `lite-lerp` for non-linear color transitions:

```javascript
import { easeIn, easeOut, easeInOut } from '@zakkster/lite-lerp';

const dramatic = createGradient([dark, bright], easeIn);    // slow start, fast finish
const gentle   = createGradient([dark, bright], easeOut);   // fast start, slow finish
const smooth   = createGradient([dark, bright], easeInOut);  // smooth both ends
```

### Health Bar with Perceptual Accuracy

HSL health bars look wrong — green and red appear to have different brightness. OKLCH L channel is perceptually uniform:

```javascript
const healthy = { l: 0.7, c: 0.25, h: 145 };  // green
const danger  = { l: 0.7, c: 0.25, h: 25 };   // red — same perceived brightness!

const hpColor = lerpOklch(danger, healthy, hp / maxHP);
healthBar.style.background = toCssOklch(hpColor);
```

### CSS Round-Trip

Parse a designer's CSS value, manipulate it in code, and write it back:

```javascript
const original = parseOklch('oklch(0.7 0.15 120 / 0.8)');
const brighter = { ...original, l: original.l + 0.1 };
element.style.color = toCssOklch(brighter);
```

## Why OKLCH Over HSL?

| | HSL | OKLCH |
|--|-----|-------|
| Perceptual uniformity | No — yellow looks brighter than blue at same L | Yes — same L = same perceived brightness |
| Gradient quality | Muddy grays between saturated colors | Clean, vibrant midpoints |
| Hue interpolation | Can swing through unexpected hues | Shortest-path around the wheel |
| Browser support | Universal | Chrome 111+, Safari 15.4+, Firefox 113+ |
| CSS spec status | Stable | CSS Color Level 4 (recommended) |

## TypeScript

```typescript
import { lerpOklch, toCssOklch, parseOklch, createGradient, type OklchColor } from '@zakkster/lite-color';

const color: OklchColor = parseOklch('oklch(0.7 0.15 120)');
const sampler = createGradient([colorA, colorB]);
```

## License

MIT
