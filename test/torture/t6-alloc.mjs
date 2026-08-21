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
const OPS = 40000;
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
}
