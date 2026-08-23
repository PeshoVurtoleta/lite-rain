/**
 * T6 -- the zero-alloc gate.
 *
 * A steady-state spawn + updateAndDraw hot loop, measured with lite-gc-profiler
 * and gated at maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0. The last rule
 * matters most: the engine's 12 SoA arrays are ArrayBuffer backing stores, which
 * live OUTSIDE the V8 heap and are invisible to a heapUsed gate (measured 152x
 * blind spot). It requires `stabilize:'deep'`, which `runOpsGate` supplies.
 *
 * A heap gate cannot substitute for a direct structural assertion either, so we
 * also pin every pool buffer's byteLength across the window: nothing may grow.
 *
 * RAIN_TORTURE_BREAK=1 injects a retained allocation into the hot body; the gate
 * must then reject the window. That is the T9 control, exercisable from here.
 */

import { RainEngine } from '../../RainEngine.js';
import { runOpsGate, BREAK, check, die, makeCtx, metrics } from './harness.mjs';

const MAX = 4000;
const W = 800, H = 600, DT = 0.016;
const OPS = 500000; // R2: 500k-op steady state (ROADMAP s.5 T6 assertion)
const WARMUP = 4000;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

export function run() {
    const ctx = makeCtx();
    const e = new RainEngine(MAX, { density: 30, gravity: 1500, wind: 400, color: '#fff' });

    // Warm the pool to a steady state OUTSIDE the measured window.
    for (let f = 0; f < 300; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }

    const buffers = [e.x, e.y, e.vx, e.vy, e.z, e.gz, e.wz, e.bucket, e.radius, e.tailMult, e.life, e.state];
    const bytesBefore = buffers.map((b) => b.buffer.byteLength);

    // R-08 bin scratch: the three per-bucket streak index lists and the splash
    // index list. These are the buffers the binning pass appends into every frame;
    // a growth here (an accidental push/realloc) is the exact regression the direct
    // length + byteLength asserts below must catch (the heap gate cannot see it).
    const idxBuffers = [e._streakIdx[0], e._streakIdx[1], e._streakIdx[2], e._splashIdx];
    const idxLenBefore = idxBuffers.map((b) => b.length);
    const idxBytesBefore = idxBuffers.map((b) => b.buffer.byteLength);

    const hot = (i) => {
        e.spawn(DT, W, H);
        e.updateAndDraw(ctx, DT, W, H);
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };

    const { report, summary, res } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

    // Structural assertion no heap gate can make: the SoA backing stores must be
    // byte-identical in size after the window.
    for (let k = 0; k < buffers.length; k++) {
        const now = buffers[k].buffer.byteLength;
        check(now === bytesBefore[k],
            () => 'T6: pool buffer #' + k + ' grew ' + bytesBefore[k] + ' -> ' + now);
    }

    // R-08 direct asserts: the bin index lists never grow -- neither their element
    // length nor their ArrayBuffer byteLength -- across a 500k-op steady state.
    for (let k = 0; k < idxBuffers.length; k++) {
        const nowLen = idxBuffers[k].length;
        const nowBytes = idxBuffers[k].buffer.byteLength;
        check(nowLen === idxLenBefore[k],
            () => 'T6: bin index list #' + k + ' length grew ' + idxLenBefore[k] + ' -> ' + nowLen);
        check(nowBytes === idxBytesBefore[k],
            () => 'T6: bin index list #' + k + ' byteLength grew ' + idxBytesBefore[k] + ' -> ' + nowBytes);
    }

    // Record metrics for the final GATE line.
    metrics.gcMajor = summary.gc.major;
    metrics.gcMinor = summary.gc.minor;
    metrics.gcMaxMs = summary.gc.maxMs;
    const perOp = res && (res.bytesPerOp !== undefined ? res.bytesPerOp
        : (res.perOp && res.perOp.bytesPerOp));
    metrics.allocBytesPerOp = Number.isFinite(perOp) ? perOp : 0;

    if (!report.ok) {
        const g = summary.gc;
        die('T6 alloc gate rejected -- verdict=' + report.verdict + ' source=' + summary.source +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            (BREAK ? ' (RAIN_TORTURE_BREAK control -- expected)' : ''));
    }

    // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
    // control silently passed, which is itself a failure.
    if (BREAK) die('T6: RAIN_TORTURE_BREAK injected allocations but the gate passed');

    // --- second window: ALL R3 features ON --------------------------------------
    // gust + splashDroplets + ripples together must still be zero-alloc: the droplet
    // emission writes into the existing pool via the spawn ring, and the ripple ring
    // is pre-allocated (64 slots) and drawn in place. Nothing may grow.
    const e2 = new RainEngine(MAX, {
        density: 30, gravity: 1500, wind: 400, color: '#fff',
        gust: 300, splashDroplets: 3, ripples: true, floorY: 560,
    });
    for (let f = 0; f < 300; f++) { e2.spawn(DT, W, H); e2.updateAndDraw(ctx, DT, W, H); }

    // Non-vacuous: the features actually fired this window. A silent stop (no splash
    // -> no droplet, no ripple) would make the zero-alloc claim meaningless.
    let s2 = 0;
    for (let i = 0; i < e2.max; i++) if (e2.state[i] === 2) s2++;
    check(s2 > 0, () => 'T6 (features on): no splash/droplet particles -- window is vacuous');
    let liveRipples = 0;
    for (let k = 0; k < 64; k++) if (e2._rippleLife[k] > 0) liveRipples++;
    check(liveRipples > 0, () => 'T6 (features on): ripple ring never populated -- window is vacuous');

    const pool2 = [e2.x, e2.y, e2.vx, e2.vy, e2.z, e2.gz, e2.wz, e2.bucket, e2.radius, e2.tailMult, e2.life, e2.state];
    const pool2Bytes = pool2.map((b) => b.buffer.byteLength);
    const idx2 = [e2._streakIdx[0], e2._streakIdx[1], e2._streakIdx[2], e2._splashIdx];
    const idx2Bytes = idx2.map((b) => b.buffer.byteLength);
    const ripple = [e2._rippleX, e2._rippleR, e2._rippleLife];
    const rippleLenBefore = ripple.map((b) => b.length);
    const rippleBytesBefore = ripple.map((b) => b.buffer.byteLength);

    const hot2 = () => { e2.spawn(DT, W, H); e2.updateAndDraw(ctx, DT, W, H); };
    const r2 = runOpsGate(hot2, { ops: OPS, warmup: WARMUP });

    for (let k = 0; k < pool2.length; k++) {
        check(pool2[k].buffer.byteLength === pool2Bytes[k],
            () => 'T6 (features on): pool buffer #' + k + ' grew');
    }
    for (let k = 0; k < idx2.length; k++) {
        check(idx2[k].buffer.byteLength === idx2Bytes[k],
            () => 'T6 (features on): bin index list #' + k + ' grew');
    }
    for (let k = 0; k < ripple.length; k++) {
        check(ripple[k].length === 64,
            () => 'T6 (features on): ripple buffer #' + k + ' length ' + ripple[k].length + ' != 64');
        check(ripple[k].length === rippleLenBefore[k],
            () => 'T6 (features on): ripple buffer #' + k + ' length grew');
        check(ripple[k].buffer.byteLength === rippleBytesBefore[k],
            () => 'T6 (features on): ripple buffer #' + k + ' byteLength grew');
    }
    if (!r2.report.ok) {
        const g = r2.summary.gc;
        die('T6 features-on alloc gate rejected -- verdict=' + r2.report.verdict +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
}
