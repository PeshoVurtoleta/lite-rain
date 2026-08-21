/**
 * T4 -- constructor + config-key abuse (the R-13 net).
 *
 * Pinned policies:
 *   new RainEngine(x), x in {0,-1,2.5,NaN,Infinity,1e12}  -> RangeError
 *   new RainEngine(1) / new RainEngine(MAX_PARTICLES)      -> OK
 *   new RainEngine(MAX_PARTICLES + 1)                      -> RangeError
 *   unknown config key                                     -> ignored (documented no-op),
 *                                                            never poisons the pool
 *   rng() returning a finite out-of-range value            -> tolerated; the cull keeps
 *                                                            the pool bounded and finite
 *   rng() returning NaN                                    -> caller contract violation,
 *                                                            NOT guarded on the hot path
 *                                                            (documented; not asserted as pass)
 */

import { RainEngine, MAX_PARTICLES } from '../../RainEngine.js';
import { check, makeCtx } from './harness.mjs';

const W = 800, H = 600, DT = 0.016;

export function run() {
    const ctx = makeCtx();

    // --- maxParticles abuse ---------------------------------------------------
    const bad = [0, -1, 2.5, NaN, Infinity, 1e12, -Infinity, '8000', null, undefined];
    for (let k = 0; k < bad.length; k++) {
        const x = bad[k];
        if (x === undefined) continue; // undefined uses the default (8000) -- valid
        let threw = false;
        try { new RainEngine(x); } catch (err) { threw = err instanceof RangeError; }
        check(threw, () => 'T4: new RainEngine(' + String(x) + ') did not throw a RangeError');
    }
    check(new RainEngine().max === 8000, () => 'T4: default maxParticles is not 8000');

    // Boundaries.
    let okLow = true;
    try { new RainEngine(1); } catch { okLow = false; }
    check(okLow, () => 'T4: new RainEngine(1) rejected -- lower bound wrong');

    let threwCeil = false;
    try { new RainEngine(MAX_PARTICLES + 1); } catch (err) { threwCeil = err instanceof RangeError; }
    check(threwCeil, () => 'T4: new RainEngine(MAX_PARTICLES + 1) did not throw');

    // --- unknown config key: ignored, never poisons --------------------------
    const junk = new RainEngine(300, { color: '#fff', density: 20, wobble: 42, foo: 'bar', gravity: 1500 });
    for (let f = 0; f < 120; f++) { junk.spawn(DT, W, H); junk.updateAndDraw(ctx, DT, W, H); }
    for (let i = 0; i < junk.max; i++) {
        if (junk.state[i] !== 0) {
            check(Number.isFinite(junk.x[i]) && Number.isFinite(junk.y[i]),
                () => 'T4: an unknown config key poisoned the pool at ' + i);
        }
    }
    check(junk.liveCount() < junk.max, () => 'T4: unknown-key engine pinned the pool');

    // --- rng returning a finite out-of-range value: tolerated, stays finite ---
    const oor = new RainEngine(300, { color: '#fff', density: 20, gravity: 1500, rng: () => 2.5 });
    for (let f = 0; f < 200; f++) { oor.spawn(DT, W, H); oor.updateAndDraw(ctx, DT, W, H); }
    for (let i = 0; i < oor.max; i++) {
        if (oor.state[i] !== 0) {
            check(Number.isFinite(oor.x[i]) && Number.isFinite(oor.y[i]),
                () => 'T4: a finite out-of-range rng produced a non-finite coordinate at ' + i);
        }
    }
    check(oor.liveCount() < oor.max, () => 'T4: out-of-range-rng engine pinned the pool');

    // color as an OKLCH object stays a string; a CSS string passes through.
    const obj = new RainEngine(10, { color: { l: 0.9, c: 0.05, h: 250 } });
    check(typeof obj.colorStr === 'string' && obj.colorStr.length > 0,
        () => 'T4: OKLCH object color did not parse to a string');
    const str = new RainEngine(10, { color: 'rgba(1,2,3,0.5)' });
    check(str.colorStr === 'rgba(1,2,3,0.5)', () => 'T4: CSS string color was not passed through');
}
