# @zakkster/lite-rain

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-rain.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-rain)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-rain?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-rain)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-rain?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-rain)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-rain?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-rain)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-1-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

Zero-GC SoA environmental rain engine with Z-depth parallax, streak-to-splash metamorphosis, and bucketed rendering. One dependency. 170 lines.

## Live Demo
https://cdpn.io/pen/debug/GgjyqWO

## Why lite-rain?

| Feature | lite-rain | weatherJS | tsparticles | p5.js |
|---|---|---|---|---|
| **Zero-GC hot path** | **Yes** | No | No | No |
| **SoA flat arrays** | **12 arrays** | No | No | No |
| **Z-depth parallax** | **Yes (0.2–1.0)** | No | No | Manual |
| **Splash metamorphosis** | **Yes** | No | No | No |
| **Bucketed rendering** | **3 tiers, 1 stroke() each** | N/A | No | No |
| **Terminal velocity** | **Depth-scaled** | No | No | No |
| **Responsive density** | **Area-aware** | No | Partial | No |
| **OKLCH color** | **Yes** | No | No | No |
| **Bundle size** | **< 2KB** | ~10KB | ~40KB | ~800KB |

## Installation

```bash
npm install @zakkster/lite-rain
```

## Quick Start

```javascript
import { RainEngine } from '@zakkster/lite-rain';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const rain = new RainEngine(8000);

let w = canvas.width, h = canvas.height;
let last = performance.now();

function loop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);
    last = time;

    rain.spawn(dt, w, h);           // 1. spawn new drops

    ctx.clearRect(0, 0, w, h);      // 2. clear (caller responsibility)
    // drawScene();                  // 3. draw your scene underneath

    rain.updateAndDraw(ctx, dt, w, h); // 4. rain overlays on top
    requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
```

> **Important:** `updateAndDraw()` does **not** clear the canvas. Rain is an overlay effect — it renders on top of whatever you've drawn. Call `ctx.clearRect()` and draw your scene before calling `updateAndDraw()`.

---

## The Rain Pipeline

### Phase 1: Streak (state = 1)

Raindrops spawn above the viewport with a random Z-depth (0.2–1.0). Every physics parameter scales by Z:

| Property | Formula | Effect |
|---|---|---|
| Gravity acceleration | `gravity × z` | Far drops fall slower |
| Wind acceleration | `wind × z` | Far drops drift less |
| Streak opacity | `z × 0.6` | Far drops are faint |
| Streak width | `z × 2.0` | Far drops are thin |
| Tail length | `blurStrength × z` | Far drops have shorter streaks |
| Terminal velocity | `maxSpeed × z` | Far drops can't exceed their depth-scaled limit |

All Z-dependent values (`gz[]`, `wz[]`, `tailMult[]`, `bucket[]`) are **precomputed at spawn** — the render loop does zero multiplication for these.

### Phase 2: Splash (state = 2)

When a streak hits the floor (`y >= h`), it metamorphoses into a splash particle:

- **Radius** computed from impact velocity: `z × (1.2 + |vy| / 2000)` — faster hits = bigger splashes
- **Bounce** velocity: `vy × -splashBounce × random` — slight upward kick
- **Spread** velocity: random horizontal from `-splashSpread*z` to `+splashSpread*z`
- **Lifetime**: `splashLifeMin` to `splashLifeMax` (0.1–0.3s default)
- **Alpha** fades by `life / splashLifeMax` — computed via precomputed `invSplashLifeMax` (one division per frame, not per particle)

Splashes render as filled circles with depth-modulated alpha.

### Bucketed Rendering

Instead of setting `globalAlpha` and `lineWidth` per-particle (which forces canvas state changes), drops are sorted into 3 depth tiers at spawn:

| Bucket | Z Range | Opacity | Width |
|---|---|---|---|
| 0 (far) | 0.2–0.4 | 0.18 | 0.6px |
| 1 (mid) | 0.4–0.7 | 0.33 | 1.1px |
| 2 (near) | 0.7–1.0 | 0.54 | 1.8px |

Each bucket renders in **one batched `ctx.stroke()` call** — 3 draw calls total for all 8,000 streaks, instead of 8,000 individual strokes. This is the single biggest performance win.

---

## Full Config Reference

All config values are live-mutable between frames.

| Option | Type | Default | Description |
|---|---|---|---|
| `gravity` | number | 1500 | Downward acceleration (px/s²). Rain is heavy. |
| `wind` | number | 200 | Horizontal wind (px/s). Positive = right, negative = left. |
| `density` | number | 5.0 | Spawn rate multiplier. Scales with canvas area automatically. |
| `maxSpeed` | number | 2500 | Terminal velocity cap (px/s). Depth-scaled per drop. |
| `blurStrength` | number | 0.04 | Velocity streak tail multiplier. Higher = longer streaks. |
| `splashBounce` | number | 0.25 | Splash bounce energy retention (0–1). |
| `splashSpread` | number | 200 | Splash horizontal spread (px). |
| `splashLifeMin` | number | 0.1 | Minimum splash lifetime (seconds). |
| `splashLifeMax` | number | 0.3 | Maximum splash lifetime (seconds). |
| `angle` | number \| null | null | Fixed rain angle (radians). `null` = natural gravity + wind. |
| `color` | OklchColor \| string | `'oklch(0.95 0.05 250)'` | Rain color. Pre-parsed at construction. |
| `rng` | Function | `Math.random` | RNG function. Inject seeded RNG for determinism. |

---

## Canvas Setup (No Built-in Resize — By Design)

lite-rain is a pure engine. Here's the recommended canvas setup:

```javascript
import { RainEngine } from '@zakkster/lite-rain';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const rain = new RainEngine();

let w = 0, h = 0;
const dpr = window.devicePixelRatio || 1;

function updateSize() {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
}

let scheduled = false;
new ResizeObserver(() => {
    if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; updateSize(); });
    }
}).observe(canvas.parentElement || document.body);

updateSize();

let last = performance.now();
function loop(time) {
    const dt = Math.min((time - last) / 1000, 0.1);
    last = time;

    rain.spawn(dt, w, h);
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, w, h);        // dark sky background
    rain.updateAndDraw(ctx, dt, w, h);

    requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

---

## Seeded Random (Deterministic Replays)

```javascript
import { RainEngine } from '@zakkster/lite-rain';
import { Random } from '@zakkster/lite-random';

const rng = new Random(42);
const rain = new RainEngine(8000, { rng: () => rng.next() });

// Same seed + same frame sequence = identical rain pattern
```

---

## Recipes

<details>
<summary><strong>🌧️ Gentle Drizzle</strong></summary>

Light, slow rain with minimal wind.

```javascript
const rain = new RainEngine(4000, {
    gravity: 800,
    wind: 50,
    density: 2.0,
    blurStrength: 0.02,
    splashBounce: 0.1,
});
```

</details>

<details>
<summary><strong>⛈️ Thunderstorm</strong></summary>

Heavy rain, strong wind, high density. Pair with lite-fireworks for lightning.

```javascript
const rain = new RainEngine(12000, {
    gravity: 2000,
    wind: 500,
    density: 10.0,
    blurStrength: 0.06,
    maxSpeed: 3000,
    splashBounce: 0.4,
    splashSpread: 300,
});
```

</details>

<details>
<summary><strong>🌨️ Sleet (Diagonal Slant)</strong></summary>

Fixed-angle rain for dramatic diagonal streaks.

```javascript
const rain = new RainEngine(6000, {
    angle: Math.PI * 0.6,  // ~108° — steep diagonal
    density: 6.0,
    blurStrength: 0.05,
    color: { l: 0.85, c: 0.03, h: 220 }, // icy blue-grey
});
```

</details>

<details>
<summary><strong>🎮 Game Scene Overlay</strong></summary>

Rain as a composited layer over your game scene.

```javascript
const rain = new RainEngine(8000);

function gameLoop(dt) {
    rain.spawn(dt, w, h);

    ctx.clearRect(0, 0, w, h);
    drawBackground();
    drawCharacters();
    drawUI();

    // Rain overlays everything
    rain.updateAndDraw(ctx, dt, w, h);
}
```

</details>

<details>
<summary><strong>🎛️ Live Wind Control</strong></summary>

All config values are live-mutable. Perfect for real-time weather systems.

```javascript
windSlider.oninput = () => rain.config.wind = +windSlider.value;
densitySlider.oninput = () => rain.config.density = +densitySlider.value;
gravitySlider.oninput = () => rain.config.gravity = +gravitySlider.value;

// Ramp wind over time for storm effect
let windTarget = 0;
setInterval(() => {
    windTarget = (Math.random() - 0.3) * 600;
}, 3000);
// In loop: rain.config.wind += (windTarget - rain.config.wind) * dt * 2;
```

</details>

<details>
<summary><strong>🎨 Colored Rain (Blood, Acid, Neon)</strong></summary>

```javascript
// Blood rain
const blood = new RainEngine(6000, {
    color: { l: 0.4, c: 0.25, h: 20 },
    gravity: 1200,
});

// Acid rain
const acid = new RainEngine(6000, {
    color: { l: 0.7, c: 0.3, h: 130 },
});

// Neon cyberpunk
const neon = new RainEngine(8000, {
    color: { l: 0.6, c: 0.25, h: 280 },
    wind: 400,
    blurStrength: 0.07,
});
```

</details>

<details>
<summary><strong>🔀 Combined with Fireworks + Sparks</strong></summary>

All three engines share the same `(ctx, dt, w, h)` API pattern.

```javascript
import { RainEngine } from '@zakkster/lite-rain';
import { FireworksEngine } from '@zakkster/lite-fireworks';
import { SparkEngine } from '@zakkster/lite-sparks';

const rain = new RainEngine(8000);
const fireworks = new FireworksEngine(5000);
const sparks = new SparkEngine(3000);

function loop(time) {
    const dt = /* ... */;

    rain.spawn(dt, w, h);

    // Fireworks draw their own background (bloom mode)
    fireworks.updateAndDraw(ctx, dt, w, h);

    // Rain overlays on top
    rain.updateAndDraw(ctx, dt, w, h);

    // Sparks on click
    sparks.updateAndDraw(ctx, dt, w, h);
}
```

</details>

---

## API

### `new RainEngine(maxParticles?, config?)`

Creates a rain engine with a pre-allocated SoA particle pool.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `maxParticles` | number | 8000 | Pool capacity. Shared between streaks and splashes. |
| `config` | RainConfig | see above | All options. Live-mutable after construction. |

### Methods

| Method | Description |
|---|---|
| `.spawn(dt, w, h)` | Spawn new drops. Call every frame. Count auto-scales with area × density. |
| `.updateAndDraw(ctx, dt, w, h)` | Physics + render. Does **not** clear canvas. Call after spawn(). |
| `.clear()` | Kill all particles immediately. |
| `.destroy()` | Null all 12 typed arrays. Idempotent. |

### Frame Loop Pattern

```javascript
rain.spawn(dt, w, h);               // 1. spawn new drops
ctx.clearRect(0, 0, w, h);          // 2. clear canvas (caller)
drawYourScene();                     // 3. your scene (caller)
rain.updateAndDraw(ctx, dt, w, h);   // 4. rain on top
```

---

## License

MIT

## Part of the @zakkster ecosystem

Zero-GC, deterministic, tree-shakeable micro-libraries for high-performance web presentation.
