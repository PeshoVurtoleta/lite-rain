/**
 * T7 -- soak + the pool-conservation invariant.
 *
 * 4096 build/tear-down cycles. Each cycle:
 *   - builds a fresh engine, runs frames, asserts the steady-state bound mid-cycle,
 *   - clear()s and asserts liveCount() === 0,
 *   - drops the only reference so the engine (and its 12 SoA buffers) can be collected.
 *
 * lite-leak tracks each engine by a WEAK reference with a PRIMITIVE tag and a
 * no-op cleanup that closes over NOTHING (closing over the engine would pin every
 * slot and report a false clean). After the cycles we force a collection, settle a
 * macrotask so FinalizationRegistry callbacks fire, and assert tracker.size() ===
 * 0: no engine outlived its cycle. Heap is sampled ACROSS cycles for diagnostics.
 *
 * @license MIT
 */

import { createLeakTracker } from '@zakkster/lite-leak';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { RainEngine } from '../../RainEngine.js';
import { check, die, makeCtx, metrics } from './harness.mjs';

const CYCLES = 4096;
const FRAMES = 20;
const MAX = 1000;
const W = 800, H = 600, DT = 0.016;

/**
 * Module-level no-op cleanup. It MUST NOT be defined inside the cycle loop: V8
 * gives every closure sharing a scope one context object, so a loop-local
 * `() => {}` would share the context that the (primitive-only) check thunks force
 * open and end up referencing `e` -- pinning every engine through the
 * FinalizationRegistry's held value and reporting a false clean. Defined here, its
 * context is the module, never a cycle's `e`.
 */
function noop() {}

export async function run() {
    const ctx = makeCtx();
    const warns = [];
    const tracker = createLeakTracker({
        name: 'rain-soak',
        onWarning: (w) => warns.push(w.kind + ':' + w.reason),
    });

    const gc = new GcProfiler().start();

    for (let c = 0; c < CYCLES; c++) {
        const e = new RainEngine(MAX, { density: 5, gravity: 1500, wind: 300, color: '#fff' });
        // cleanup is a module-level fn and the tag is a primitive: neither closes
        // over `e`, so finalization is never defeated.
        tracker.track(e, noop, c, { audit: true });

        for (let f = 0; f < FRAMES; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }

        // Read telemetry into PRIMITIVES so the check thunks never capture `e`.
        const liveRun = e.liveCount();
        check(liveRun <= MAX, () => 'T7: liveCount ' + liveRun + ' exceeded max ' + MAX + ' at cycle ' + c);
        check(liveRun < MAX, () => 'T7: pool pinned at max at cycle ' + c + ' (steady-state bound violated)');

        e.clear();
        const liveClear = e.liveCount();
        check(liveClear === 0, () => 'T7: liveCount ' + liveClear + ' != 0 after clear() at cycle ' + c);
        e.destroy();

        if ((c & 511) === 0) {
            globalThis.gc();
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
        // e goes out of scope here -- nothing retains it.
    }

    // Force collection and settle a macrotask so FinalizationRegistry callbacks
    // fire. Retry a few rounds: after the heavy earlier tiers the heap is large,
    // and V8 can deliver FR callbacks incrementally across collections.
    let size = tracker.size();
    for (let r = 0; r < 12 && size !== 0; r++) {
        globalThis.gc();
        await new Promise((res) => setTimeout(res, 60));
        size = tracker.size();
        if (process.env.RAIN_TORTURE_DEBUG === '1') {
            process.stderr.write('T7 settle round ' + r + ' size=' + size + '\n');
        }
    }
    const findings = tracker.audit();
    gc.stop();

    metrics.leakSize = size;
    metrics.leakFindings = findings.length;
    metrics.leakWarnings = warns.length;

    if (size !== 0) {
        die('T7 soak: ' + size + ' engine(s) outlived their cycle -- retention leak');
    }
    if (findings.length !== 0) {
        die('T7 soak: ' + findings.length + ' leak finding(s): ' +
            findings.map((f) => f.kind + ':' + f.reason).join(', '));
    }
}
