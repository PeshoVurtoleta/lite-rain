/**
 * @zakkster/lite-rain -- torture harness.
 *
 * Shared scratch, zero-alloc assertions, a seeded PRNG, a zero-cost fake canvas
 * context, and the lite-gc-profiler gate wrapper. Every tier imports from here so
 * the discipline is enforced in one place:
 *
 *   - All scratch (the engine, the fake ctx, index buffers) is allocated ONCE by
 *     the tier, OUTSIDE every loop. This module hands out helpers, never per-call
 *     allocations on a hot path.
 *   - `check()` builds its message string only on failure -- a template literal
 *     per iteration is an allocation and would fail the T6 gate.
 *   - The PRNG is a seeded xorshift32. On failure a tier prints the seed so a case
 *     replays with `RAIN_TORTURE_SEED=... node --expose-gc test/torture.mjs`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     sequentially, never nested. `runOpsGate` opens and closes one window.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with RAIN_TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.RAIN_TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into T6's hot loop. */
export const BREAK = process.env.RAIN_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Metrics collected across tiers for the final GATE line (diagnostic, stderr). */
export const metrics = {
    leakSize: 0, leakFindings: 0, leakWarnings: 0,
    gcMajor: 0, gcMinor: 0, gcMaxMs: 0, allocBytesPerOp: 0,
};

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg +
        '\n  replay: RAIN_TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * A zero-cost fake canvas 2D context. Draw methods are empty; the style props are
 * writable no-ops. A torture run measures the engine, never a canvas.
 */
export function makeCtx() {
    return {
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {},
        clearRect() {},
    };
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so `maxArrayBuffersGrowth` resolves
 * (ArrayBuffer backing stores live outside the V8 heap).
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary, res };
}
