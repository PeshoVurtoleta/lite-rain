/**
 * T8 -- the R3 OFF-path CROSS-VERSION golden, and the gust oscillator.
 *
 *   1. OFF GOLDEN. The headline invariant of R3: on its OFF path (gust:0, gustRate
 *      default, floorY:null, splashDroplets:0, ripples:false) the engine is
 *      BYTE-IDENTICAL to the ORIGINAL v1.2.0 engine. The golden is a COMMITTED
 *      fixture (`fixtures/v1.2.0-off-golden.json`) captured by running the actual
 *      1.2.0 source (commit 9aaa783) over a fixed seeded scenario -- see
 *      `fixtures/generate-golden.mjs`. Here we run the CURRENT R3 engine over the
 *      SAME scenario with base keys only (R3 defaults fill the rest) and assert the
 *      raw bytes of x/y/vx/vy/state/life match the fixture. This is not a tautology:
 *      the two runs are different engine SOURCES.
 *
 *   2. GUST OSCILLATOR. A single frozen drop (gz == wz == 0) has exactly one force
 *      on vx: the gust windPulse. vx(t) ~ (gust/gustRate)(1 - cos(gustRate*t)), so it
 *      rises through a half-period then FALLS back -- the per-frame increment
 *      (windPulse) changes sign each half-period. Doubling gustRate halves the
 *      period; gustRate:0 freezes it (windPulse == 0, vx stays exactly 0).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RainEngine } from '../../RainEngine.js';
import { makePrng, check } from './harness.mjs';
import { GOLDEN, GOLDEN_SEED, b64 } from './fixtures/golden-scenario.mjs';

/** The default gust frequency (matches the constructor's Math.fround(2*PI/3)). */
const RATE = Math.fround(Math.PI * 2 / 3);

const ctx = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, stroke() {}, fill() {},
    clearRect() {},
};

/**
 * Run the CURRENT engine over the fixed golden scenario and return the base64 of
 * each buffer. `mutate(e, f)` is an optional per-frame hook the T9 control uses to
 * inject a mutation the OFF path must never make -- here it is undefined.
 */
export function runGoldenScenario(engine, mutate) {
    for (let f = 0; f < GOLDEN.frames; f++) {
        engine.spawn(GOLDEN.dt, GOLDEN.w, GOLDEN.h);
        engine.updateAndDraw(ctx, GOLDEN.dt, GOLDEN.w, GOLDEN.h);
        if (mutate !== undefined) mutate(engine, f);
    }
    return {
        x: b64(engine.x), y: b64(engine.y), vx: b64(engine.vx), vy: b64(engine.vy),
        state: b64(engine.state), life: b64(engine.life),
    };
}

/**
 * Build a current R3 engine on its OFF path (base keys only; defaults fill R3),
 * constructed DIRECTLY with the seeded golden rng -- matching generate-golden.mjs
 * exactly, in the constructor call itself, rather than via a post-construct
 * `config.rng = ...` overwrite. The overwrite pattern would mask a FUTURE
 * constructor-time rng draw: it would still spawn from seeded[0] (the overwrite
 * happens before any frame runs) but a real constructor draw would pull from the
 * discarded generator first, silently shifting the WHOLE stream by one draw yet
 * still starting the observed sequence at seeded[0] -- so it could still match the
 * golden by coincidence on some inputs. Threading the seeded rng through
 * construction means any constructor-time draw consumes seeded[0] for real and
 * shifts every subsequent draw, so a regression fails the golden loudly.
 */
export function buildOffEngine() {
    const prng = makePrng(GOLDEN_SEED);
    return new RainEngine(GOLDEN.max, {
        density: GOLDEN.density, gravity: GOLDEN.gravity, wind: GOLDEN.wind,
        color: GOLDEN.color, rng: () => prng() / 4294967296,
    });
}

/** Load the committed v1.2.0 byte-golden fixture. */
export function loadGolden() {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, 'fixtures', 'v1.2.0-off-golden.json'), 'utf8'));
}

// --- part 1: cross-version OFF-path byte-golden -----------------------------
function offGolden() {
    const golden = loadGolden();
    const snap = runGoldenScenario(buildOffEngine());
    const keys = ['x', 'y', 'vx', 'vy', 'state', 'life'];
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        check(snap[key] === golden.buffers[key],
            () => 'T8 OFF: R3 engine buffer "' + key + '" is NOT byte-identical to the committed ' +
                  'v1.2.0 golden (fixtures/v1.2.0-off-golden.json, commit ' + golden.meta.sourceCommit +
                  ') -- the OFF path diverged from v1.2.0');
    }
}

// --- part 2: the gust oscillator --------------------------------------------
/**
 * Install one frozen drop whose only vx force is the gust, then integrate `frames`
 * steps and return the per-frame vx trace. gz == wz == 0 so gravity/wind add
 * nothing; a huge life keeps it off the age cap; a wide canvas keeps it uncauled.
 */
function runDrop(gust, gustRate, frames) {
    const GW = 4000, GH = 600, GDT = 0.005;
    const e = new RainEngine(1, {
        gravity: 1500, wind: 0, gust, gustRate, color: '#fff', rng: () => 0.5,
    });
    e.state[0] = 1; e.z[0] = 1; e.gz[0] = 0; e.wz[0] = 0;
    e.vx[0] = 0; e.vy[0] = 0; e.x[0] = GW / 2; e.y[0] = 100;
    e.life[0] = 1e6; e.bucket[0] = 2; e.tailMult[0] = 0; e.radius[0] = 0;

    const vx = new Float64Array(frames + 1);
    for (let f = 1; f <= frames; f++) {
        e.updateAndDraw(ctx, GDT, GW, GH);
        vx[f] = e.vx[0];
        check(e.state[0] === 1,
            () => 'T8 gust: the frozen drop left state 1 at frame ' + f + ' (culled/splashed?)');
    }
    return vx;
}

function gustOscillates() {
    // Default rate: period ~= 2*PI/RATE = 3.0s -> 600 frames at dt=0.005. Peak at the
    // half-period (~300), back near zero at the full period (~600).
    const vx = runDrop(100, RATE, 600);
    const q = vx[150], peak = vx[300], mid2 = vx[450], end = vx[600];

    check(peak > 0, () => 'T8 gust: vx did not rise under a live gust (peak=' + peak + ')');
    check(q > 0 && q < peak,
        () => 'T8 gust: quarter-period sample not on the rising edge (q=' + q + ' peak=' + peak + ')');
    // The FALL back through the second half is the sign change: windPulse (the vx
    // increment) went negative, so vx retreats from its peak toward zero.
    check(mid2 < peak,
        () => 'T8 gust: vx did not fall after the half-period (mid2=' + mid2 + ' peak=' + peak +
              ') -- the gust increment never changed sign');
    check(end < mid2 && end < peak * 0.2,
        () => 'T8 gust: vx did not return toward zero at the full period (end=' + end +
              ' peak=' + peak + ') -- no full oscillation');

    // gustRate * 2 halves the period: at frame 300 the base engine sits at its peak
    // while the doubled-rate engine has completed a FULL period and is back near zero.
    const vx2 = runDrop(100, RATE * 2, 600);
    check(vx2[150] > 0,
        () => 'T8 gust: doubled-rate engine did not rise (vx2[150]=' + vx2[150] + ')');
    check(vx2[300] < peak * 0.3,
        () => 'T8 gust: doubling gustRate did not halve the period (vx2[300]=' + vx2[300] +
              ' vs base peak ' + peak + ')');

    // gustRate:0 -> sin(_elapsed*0) == 0 -> windPulse == 0 -> vx frozen at exactly 0.
    const vx0 = runDrop(100, 0, 200);
    check(vx0[100] === 0 && vx0[200] === 0,
        () => 'T8 gust: gustRate:0 did not freeze the gust (vx0[100]=' + vx0[100] +
              ' vx0[200]=' + vx0[200] + ')');

    // Negative gustRate REVERSES the oscillation: windPulse = sin(elapsed*gustRate)
    // *gust*dt is an ODD function of gustRate (sin(-x) == -sin(x)), so a negated
    // rate integrates to the sign-mirrored trace at the SAME period -- rising edge
    // goes negative instead of positive, and the (negated) peak magnitude matches.
    const vxNeg = runDrop(100, -RATE, 600);
    check(vxNeg[150] < 0 && vxNeg[150] > -peak,
        () => 'T8 gust: negative gustRate quarter-period sample is not on the mirrored ' +
              '(negative) rising edge (vxNeg[150]=' + vxNeg[150] + ' vs -peak=' + (-peak) + ')');
    check(vxNeg[300] < 0,
        () => 'T8 gust: negative gustRate did not reverse the half-period trough sign ' +
              '(vxNeg[300]=' + vxNeg[300] + ')');
    check(Math.abs(vxNeg[300] + peak) < 1e-6,
        () => 'T8 gust: negative gustRate trough magnitude does not mirror the positive-rate ' +
              'peak (vxNeg[300]=' + vxNeg[300] + ' vs -peak=' + (-peak) + ')');
    check(Math.abs(vxNeg[600]) < peak * 0.2,
        () => 'T8 gust: negative gustRate did not return toward zero at the full period ' +
              '(vxNeg[600]=' + vxNeg[600] + ' peak=' + peak + ')');
}

export function run() {
    offGolden();
    gustOscillates();
}
