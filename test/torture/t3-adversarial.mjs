/**
 * T3 -- adversarial force fields (the R-01/R-02 leak net).
 *
 * The pool's contract is behavioural: under any finite force field,
 * count(state != 0) converges to a bounded steady state and never climbs
 * monotonically to `max`. Any force keeping a drop off the floor (negative
 * gravity, an upward angle, extreme wind) used to leak it forever, pinning the
 * pool at `max` and blanking the screen. The R-01 off-screen cull recycles them.
 *
 * For each scenario we run 600+ frames, then:
 *   - assert the pool is BOUNDED (below `max`, unless deliberately over-spawned),
 *   - stop spawning and DRAIN -- every live drop must be able to leave (-> 0),
 *   - spawn one more normal frame and confirm it still recycles.
 *
 * A drop that cannot drain to 0 is a leak, full stop.
 */

import { RainEngine } from '../../RainEngine.js';
import { check, makeCtx } from './harness.mjs';

const W = 800, H = 600, DT = 0.016;
const FRAMES = 700;
const DRAIN = 8000;

function drainToZero(e, ctx, name) {
    for (let f = 0; f < DRAIN; f++) {
        e.updateAndDraw(ctx, DT, W, H);
        if (e.liveCount() === 0) break;
    }
    check(e.liveCount() === 0,
        () => 'T3 [' + name + ']: pool did not drain -- ' + e.liveCount() +
              ' drops cannot leave the simulable region (LEAK)');
}

function recyclesAgain(e, ctx, name, saturates) {
    // After draining, resumed operation must stay finite and not jam. For a normal
    // spawn window it reaches a bounded steady state below max; a deliberately
    // over-capacity density legitimately re-saturates, so only the finiteness half
    // applies there. (Whether a drop born inside a blown-up wind spawn window
    // survives its first frame is R-04 overdraw, not a leak; drainToZero already
    // proved every live drop can leave.)
    for (let f = 0; f < 30; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }
    if (!saturates) {
        check(e.liveCount() < e.max,
            () => 'T3 [' + name + ']: a normal run after drain pinned the pool (' +
                  e.liveCount() + '/' + e.max + ')');
    }
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            check(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]),
                () => 'T3 [' + name + ']: NaN in pool after resumed operation');
        }
    }
}

function scenario(name, config, opts) {
    const ctx = makeCtx();
    const max = opts && opts.max ? opts.max : 4000;
    const saturates = !!(opts && opts.saturates);
    const e = new RainEngine(max, config);
    for (let f = 0; f < FRAMES; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }
    if (!saturates) {
        check(e.liveCount() < e.max,
            () => 'T3 [' + name + ']: pool pinned at max (' + e.liveCount() + '/' + e.max +
                  ') -- the R-01 cull did not recycle off-screen drops');
    }
    drainToZero(e, ctx, name);
    recyclesAgain(e, ctx, name, saturates);
}

export function run() {
    scenario('negative gravity', { gravity: -1500, wind: 0, density: 8, color: '#fff' });
    scenario('upward angle -PI/2', { angle: -Math.PI / 2, density: 8, color: '#fff' });
    scenario('zero gravity + strong wind', { gravity: 0, wind: 6000, density: 8, color: '#fff' });
    scenario('wind +20000', { wind: 20000, gravity: 300, density: 8, color: '#fff' });
    scenario('wind -20000', { wind: -20000, gravity: 300, density: 8, color: '#fff' });
    scenario('maxSpeed 0 + wind', { maxSpeed: 0, wind: 9000, gravity: 1500, density: 8, color: '#fff' });
    scenario('density over capacity', { density: 1e6, gravity: 1500, color: '#fff' },
        { max: 500, saturates: true });

    // No-drift corners: a legal finite field with ZERO net motion. These freeze a
    // drop INSIDE the box, so the positional cull never fires -- only the age cap
    // recycles them. They saturate during the build (age cap is 12s, longer than
    // the build window), then MUST drain under spawn-free frames. Without the age
    // cap they pin at max forever (the R-01 leak the positional cull alone misses).
    scenario('gravity 0 + wind 0 (frozen)', { gravity: 0, wind: 0, density: 8, color: '#fff' },
        { saturates: true });
    scenario('angle 0 + gravity 0 (frozen)', { gravity: 0, angle: 0, density: 8, color: '#fff' },
        { saturates: true });
    scenario('maxSpeed 0 + wind 0 (frozen)', { maxSpeed: 0, wind: 0, gravity: 1500, density: 8, color: '#fff' },
        { saturates: true });

    // The full angle ring: every direction must recycle.
    const ctx = makeCtx();
    for (let k = 0; k < 16; k++) {
        const angle = (k * Math.PI) / 8;
        const e = new RainEngine(1000, { angle, gravity: 1500, wind: 500, density: 8, color: '#fff' });
        for (let f = 0; f < 400; f++) { e.spawn(DT, W, H); e.updateAndDraw(ctx, DT, W, H); }
        check(e.liveCount() < e.max,
            () => 'T3 [angle ring ' + k + ']: pool pinned at max (' + e.liveCount() + ')');
        for (let f = 0; f < 4000; f++) {
            e.updateAndDraw(ctx, DT, W, H);
            if (e.liveCount() === 0) break;
        }
        check(e.liveCount() === 0,
            () => 'T3 [angle ring ' + k + ' = ' + angle.toFixed(3) + ']: did not drain (LEAK)');
    }

    // Per-frame force flips (teleport churn): gravity and wind flip sign each frame.
    // Only NEW spawns pick up the flipped force (gz/wz are precomputed at spawn),
    // so the pool holds a mix of rising and falling drops -- all must recycle.
    {
        const e = new RainEngine(4000, { gravity: 1500, wind: 5000, density: 8, color: '#fff' });
        for (let f = 0; f < FRAMES; f++) {
            e.config.gravity = (f & 1) ? -1500 : 1500;
            e.config.wind = (f & 1) ? 20000 : -20000;
            e.spawn(DT, W, H);
            e.updateAndDraw(ctx, DT, W, H);
        }
        check(e.liveCount() < e.max,
            () => 'T3 [force flips]: pool pinned at max (' + e.liveCount() + ')');
        drainToZero(e, ctx, 'force flips');
    }
}
