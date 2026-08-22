/**
 * @zakkster/lite-rain -- frame-time bench.
 *
 *     node bench/bench.mjs        (npm run bench)
 *
 * Build ONE engine, run N frames at a fixed dt over a zero-cost fake ctx, and
 * report per-frame percentiles (p50/p90/p99) with a provenance stamp. This is a
 * perf harness, not a gate: it never fails, it reports. Compare two runs (e.g.
 * across a code change) to read a delta.
 *
 * Not shipped: bench/ is excluded from package.json files[]. It exists to prove
 * the hot-path claims in the CHANGELOG, not to run on a user's machine.
 *
 * @license MIT
 */

import { RainEngine } from '../RainEngine.js';

/** Zero-cost fake canvas 2D context. Draw methods are empty; styles are no-ops. */
function makeCtx() {
    return {
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {},
        clearRect() {},
    };
}

/** Seeded xorshift32 in [0, 1) -- deterministic occupancy across runs. */
function seededRng(seed) {
    let s = (seed >>> 0) || 1;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

const SEED = Number(process.env.RAIN_BENCH_SEED || 0x9e3779b9) >>> 0 || 1;
const MAX = Number(process.env.RAIN_BENCH_MAX || 8000);
const FRAMES = Number(process.env.RAIN_BENCH_FRAMES || 20000);
const WARMUP = Number(process.env.RAIN_BENCH_WARMUP || 2000);
const DENSITY = Number(process.env.RAIN_BENCH_DENSITY || 30);
const W = 1920, H = 1080, DT = 1 / 60;

const ctx = makeCtx();
const e = new RainEngine(MAX, {
    density: DENSITY, gravity: 1500, wind: 400, color: '#fff', rng: seededRng(SEED),
});

// Warm to a steady-state occupancy OUTSIDE the timed window.
for (let f = 0; f < WARMUP; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }

const samples = new Float64Array(FRAMES);
for (let f = 0; f < FRAMES; f++) {
    const t0 = performance.now();
    e.spawn(DT, W, H);
    e.updateAndDraw(ctx, DT, W, H);
    samples[f] = performance.now() - t0;
}

const occupancy = e.liveCount();

// Percentiles over a sorted copy (bench-only; not a hot path).
const sorted = Array.prototype.slice.call(samples).sort((a, b) => a - b);
function pct(p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }

let sum = 0;
for (let f = 0; f < FRAMES; f++) sum += samples[f];

process.stdout.write(
    'lite-rain bench\n' +
    '  provenance: node=' + process.version + ' seed=' + SEED +
    ' max=' + MAX + ' density=' + DENSITY + ' frames=' + FRAMES +
    ' occupancy=' + occupancy + '/' + MAX +
    ' canvas=' + W + 'x' + H + ' dt=' + DT.toFixed(5) + '\n' +
    '  frame-ms: p50=' + pct(0.50).toFixed(4) +
    ' p90=' + pct(0.90).toFixed(4) +
    ' p99=' + pct(0.99).toFixed(4) +
    ' mean=' + (sum / FRAMES).toFixed(4) +
    ' min=' + sorted[0].toFixed(4) +
    ' max=' + sorted[sorted.length - 1].toFixed(4) + '\n');
