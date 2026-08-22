/**
 * T8 -- seeded-rng determinism (engine-vs-engine).
 *
 * Two R2 engines fed the SAME seeded rng must produce byte-identical x/y/vx/vy/
 * state/life snapshots after N frames. This is deliberately NOT a position-by-
 * position match against v1.1.0: the R2 ring cursor changes SLOT ASSIGNMENT, so a
 * v1.1.0 layout snapshot would not byte-match and that is expected, not a
 * regression (the DRAW SET identity is proven separately in T5). What must still
 * hold is that the engine is a pure function of its seed -- reproducible replays.
 *
 * The run is asserted non-vacuous: the pool must end live and mixed-state, so
 * byte-identity is not trivially true of two empty pools.
 */

import { RainEngine } from '../../RainEngine.js';
import { SEED, makePrng, check } from './harness.mjs';

const W = 800, H = 600, DT = 0.016;
const FRAMES = 400;

/** Seeded xorshift32 in [0, 1) -- a fresh, identically-seeded stream per engine. */
function floatRng(seed) {
    const next = makePrng(seed);
    return () => next() / 4294967296;
}

function build(seed) {
    return new RainEngine(600, {
        density: 20, gravity: 1500, wind: 300, color: '#fff', rng: floatRng(seed),
    });
}

export function run() {
    const ctx = {
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {},
    };

    const seed = (SEED ^ 0x5eed1234) >>> 0 || 1;
    const a = build(seed);
    const b = build(seed);

    for (let f = 0; f < FRAMES; f++) {
        a.spawn(DT, W, H); a.updateAndDraw(ctx, DT, W, H);
        b.spawn(DT, W, H); b.updateAndDraw(ctx, DT, W, H);
    }

    // Non-vacuous: a live, mixed pool (not two empty pools trivially equal).
    const live = a.liveCount();
    check(live > 0 && live < a.max,
        () => 'T8: run was vacuous -- liveCount ' + live + '/' + a.max +
              ' (need a live, non-saturated pool for a meaningful byte-identity)');

    for (let i = 0; i < a.max; i++) {
        check(a.x[i] === b.x[i] && a.y[i] === b.y[i] &&
              a.vx[i] === b.vx[i] && a.vy[i] === b.vy[i] &&
              a.state[i] === b.state[i] && a.life[i] === b.life[i],
            () => 'T8: two same-seed engines diverged at slot ' + i +
                  ' (x ' + a.x[i] + '/' + b.x[i] + ', state ' + a.state[i] + '/' + b.state[i] + ')');
    }
}
