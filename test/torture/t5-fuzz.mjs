/**
 * T5 -- differential fuzz vs an independent scan oracle (lands with R2's binning).
 *
 * Two independent claims, one seeded corpus:
 *
 *   1. ORACLE. After every frame, an independent full-scan (`state != 0`) asserts
 *      each live drop is finite and on a plausible trajectory -- a surviving streak
 *      is inside the simulable region and above the floor; a splash still has life
 *      left and sits at or above the floor. A divergence prints the op index and
 *      the one-env-var replay via `die`.
 *
 *   2. DRAW SET IDENTICAL. R2's single binning pass and ring cursor change the
 *      iteration ORDER and slot ASSIGNMENT, never WHICH drops are drawn or their
 *      pixels. We log the engine's binned draw calls, then render the SAME pool
 *      state with a reference full-scan (0..max) render, and assert the SORTED
 *      draw-call multisets are identical (order-independent). A binning pass that
 *      ever bins a culled/aged (state 0) drop emits an extra record the full scan
 *      does not, and this check catches it (exercised as a control in T9).
 *
 * This tier is a correctness fuzz, not the alloc gate (that is T6), so it may
 * allocate freely: the log arrays and record strings are diagnostic scaffolding.
 */

import { RainEngine, RAIN_PRESETS } from '../../RainEngine.js';
import { SEED, makePrng, check } from './harness.mjs';

/** Age-cap ceiling (MAX_FALL_LIFE in RainEngine.js); a streak's life stays in (0, cap]. */
const LIFE_CAP = 12;
const EPS = 1e-3;

/**
 * A draw-call recorder. moveTo/lineTo pairs emit one streak record; arc emits one
 * splash record. Each record snapshots the current globalAlpha / lineWidth so the
 * comparison is over the exact pixels a bucket would stroke.
 */
export function makeLogCtx(log) {
    let mx = 0, my = 0;
    return {
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        beginPath() {}, stroke() {}, fill() {}, clearRect() {},
        moveTo(x, y) { mx = x; my = y; },
        lineTo(x, y) {
            log.push('S ga=' + this.globalAlpha + ' lw=' + this.lineWidth +
                ' ' + mx + ',' + my + ' -> ' + x + ',' + y);
        },
        arc(x, y, r) {
            log.push('P ga=' + this.globalAlpha + ' ' + x + ',' + y + ' r=' + r);
        },
        // Ripple rings stroke via ellipse; the draw-set comparison is over streaks
        // (moveTo/lineTo) and splashes (arc) only, so ellipse is an unlogged no-op --
        // ripples are an independent overlay, not part of the pool's draw set.
        ellipse() {},
    };
}

/**
 * The reference render: a full 0..max scan that mirrors the engine's draw sequence
 * exactly (same bucket alpha/width, same per-drop math), but WITHOUT the binning.
 * Renders the pool AS-IS -- call it right after updateAndDraw, before the next step.
 */
export function refRender(e, ctx) {
    ctx.lineCap = 'round';
    ctx.strokeStyle = e.colorStr;
    ctx.fillStyle = e.colorStr;
    const invSplashLifeMax = 1.0 / e.config.splashLifeMax;

    for (let bi = 0; bi < 3; bi++) {
        const bucket = e._buckets[bi];
        ctx.globalAlpha = bucket.zAvg * 0.6;
        ctx.lineWidth = bucket.zAvg * 2.0;
        ctx.beginPath();
        for (let i = 0; i < e.max; i++) {
            if (e.state[i] === 1 && e.bucket[i] === bucket.id) {
                ctx.moveTo(e.x[i], e.y[i]);
                ctx.lineTo(e.x[i] - e.vx[i] * e.tailMult[i], e.y[i] - e.vy[i] * e.tailMult[i]);
            }
        }
        ctx.stroke();
    }
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] === 2) {
            ctx.globalAlpha = (e.life[i] * invSplashLifeMax) * e.z[i];
            ctx.beginPath();
            ctx.arc(e.x[i], e.y[i], e.radius[i], 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1.0;
}

/** Order-independent multiset equality: sort copies, then compare element-wise. */
export function sortedEqual(a, b) {
    if (a.length !== b.length) return false;
    const sa = a.slice().sort();
    const sb = b.slice().sort();
    for (let k = 0; k < sa.length; k++) if (sa[k] !== sb[k]) return false;
    return true;
}

/** The independent oracle: every live drop finite and on a plausible trajectory. */
function oracle(e, w, h, op) {
    // R3: the floor line is floorY when set, else h (mirrors the engine's `fy`).
    const fy = e.config.floorY !== null ? e.config.floorY : h;
    for (let i = 0; i < e.max; i++) {
        const s = e.state[i];
        if (s === 0) continue;
        check(s === 1 || s === 2,
            () => 'T5 oracle: invalid state ' + s + ' at slot ' + i + ' op ' + op);

        const x = e.x[i], y = e.y[i], vx = e.vx[i], vy = e.vy[i], life = e.life[i];
        check(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(vx) &&
              Number.isFinite(vy) && Number.isFinite(life),
            () => 'T5 oracle: non-finite live drop at slot ' + i + ' op ' + op +
                  ' (x=' + x + ' y=' + y + ' vx=' + vx + ' vy=' + vy + ' life=' + life + ')');

        if (s === 1) {
            // A streak that survived this frame's cull is inside the simulable
            // region and strictly above the floor (else it would have splashed).
            check(x >= -200 && x <= w + 200 && y >= -200,
                () => 'T5 oracle: streak left the region uncauled at slot ' + i +
                      ' op ' + op + ' (x=' + x + ' y=' + y + ' w=' + w + ')');
            check(y < fy,
                () => 'T5 oracle: streak at/below floor should have splashed at slot ' +
                      i + ' op ' + op + ' (y=' + y + ' fy=' + fy + ')');
            check(life > 0 && life <= LIFE_CAP + EPS,
                () => 'T5 oracle: streak life out of (0, cap] at slot ' + i + ' op ' +
                      op + ' (life=' + life + ')');
        } else {
            check(life > 0,
                () => 'T5 oracle: expired splash not recycled at slot ' + i + ' op ' + op);
            check(y <= fy + EPS,
                () => 'T5 oracle: splash below floor at slot ' + i + ' op ' + op +
                      ' (y=' + y + ' fy=' + fy + ')');
        }
    }
}

function fuzzScenario(name, config, prngCtl, prngRng) {
    const MAX = 2000;
    const OPS = 2500;
    const SIZES = [[800, 600], [1280, 720], [400, 300], [1920, 1080]];

    const rng = () => prngRng() / 4294967296;
    const e = new RainEngine(MAX, { ...config, rng, color: '#fff' });

    for (let op = 0; op < OPS; op++) {
        const r = prngCtl();
        const size = SIZES[(r >>> 3) & 3];
        const w = size[0], h = size[1];
        // Vary dt across a plausible range, occasionally degenerate (no-op).
        const dtSel = r & 7;
        const dt = dtSel === 0 ? 0 : dtSel === 1 ? -0.02 : (0.008 + ((r >>> 6) & 15) * 0.004);

        // Mixed ops: usually spawn+update; occasionally clear or skip spawn.
        if ((r & 31) === 7) e.clear();
        if ((r & 3) !== 0) e.spawn(dt, w, h);

        const binLog = [];
        e.updateAndDraw(makeLogCtx(binLog), dt, w, h);

        oracle(e, w, h, op + '/' + name);

        // Periodically prove the binned draw set equals a full-scan render of the
        // same committed pool -- order-independent, so we compare SORTED multisets.
        if ((op & 63) === 0) {
            const refLog = [];
            refRender(e, makeLogCtx(refLog));
            check(sortedEqual(binLog, refLog),
                () => 'T5 draw-set DIVERGED [' + name + '] op ' + op +
                      ': binned=' + binLog.length + ' records, reference=' + refLog.length +
                      ' -- the binning pass drew a different multiset than a full scan');
        }
    }
}

export function run() {
    // Distinct streams for control decisions and the engine rng so control choices
    // never perturb the physics rng stream.
    const scenarios = [
        ['normal', { gravity: 1500, wind: 400, density: 20 }],
        ['strong wind', { gravity: 300, wind: 12000, density: 15 }],
        ['negative gravity', { gravity: -1500, wind: 0, density: 15 }],
        ['zero gravity + wind', { gravity: 0, wind: 6000, density: 15 }],
        ['angled', { angle: Math.PI / 5, gravity: 1500, wind: 500, density: 20 }],
        ['frozen field', { gravity: 0, wind: 0, density: 15 }],
        // R3 scenarios. gust storm exercises the oscillating windPulse on angled
        // rain; droplets/ripples exercise the two guarded cold blocks; floorY places
        // the splash line above the frame bottom (250 < every SIZES height).
        ['gust storm', { ...RAIN_PRESETS.storm }],
        ['droplets', { gravity: 1800, wind: 300, density: 18, splashDroplets: 3 }],
        ['ripples', { gravity: 1800, wind: 300, density: 18, ripples: true }],
        ['floorY', { gravity: 1800, wind: 200, density: 18, floorY: 250 }],
    ];
    for (let s = 0; s < scenarios.length; s++) {
        const prngCtl = makePrng((SEED ^ (0x1000 + s * 0x77)) >>> 0);
        const prngRng = makePrng((SEED ^ (0x9abc + s * 0x31)) >>> 0);
        fuzzScenario(scenarios[s][0], scenarios[s][1], prngCtl, prngRng);
    }
}
