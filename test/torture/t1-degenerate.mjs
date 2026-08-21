/**
 * T1 -- degenerate inputs.
 *
 * Cross spawn/updateAndDraw with degenerate `dt` and `w`/`h`, and every validated
 * config key set to NaN/Infinity/negative. Each cell has a PINNED policy:
 *
 *   dt in {0, -0.05, NaN}          -> no-op step (clamped to 0), no NaN in pool
 *   dt in {+Inf, 1e9}              -> clamped to 0.1, no NaN in pool
 *   dt subnormal                   -> tiny finite step, no NaN in pool
 *   w/h in {0, -800, NaN, +Inf}    -> documented no-op (spawn + update both bail)
 *   config key = NaN / Infinity    -> constructor THROWS naming the key (the door)
 *   config key = negative (finite) -> accepted (finite is valid; sign is not the door's job)
 *
 * "Silently poisons the pool" is not a policy. No cell may leave a NaN behind.
 */

import { RainEngine } from '../../RainEngine.js';
import { check, makeCtx } from './harness.mjs';

const W = 800, H = 600;

function noNaN(e, where) {
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            check(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]) &&
                  Number.isFinite(e.vx[i]) && Number.isFinite(e.vy[i]),
                () => 'T1: NaN/Inf in pool slot ' + i + ' after ' + where);
        }
    }
}

export function run() {
    const ctx = makeCtx();
    const e = new RainEngine(500, { density: 40, color: '#fff' });

    // --- degenerate dt across spawn + updateAndDraw ---------------------------
    const dts = [0, -0.05, NaN, Infinity, 1e9, Number.MIN_VALUE];
    for (let k = 0; k < dts.length; k++) {
        const dt = dts[k];
        e.clear();
        e.spawn(0.016, W, H);         // seed a normal pool first
        e.updateAndDraw(ctx, dt, W, H);
        e.spawn(dt, W, H);
        e.updateAndDraw(ctx, dt, W, H);
        noNaN(e, 'dt=' + dt);
    }

    // dt <= 0 / NaN in spawn must produce zero new drops (no-op).
    for (let k = 0; k < 3; k++) {
        const dt = [0, -0.05, NaN][k];
        e.clear();
        e.spawn(dt, W, H);
        check(e.liveCount() === 0, () => 'T1: spawn(dt=' + dt + ') created drops -- not a no-op');
    }

    // --- degenerate dimensions ------------------------------------------------
    const dims = [0, -800, NaN, Infinity];
    for (let k = 0; k < dims.length; k++) {
        const d = dims[k];
        // spawn with a bad width -> no-op
        e.clear();
        e.spawn(0.016, d, H);
        check(e.liveCount() === 0, () => 'T1: spawn(w=' + d + ') created drops -- not a no-op');
        e.spawn(0.016, W, d);
        check(e.liveCount() === 0, () => 'T1: spawn(h=' + d + ') created drops -- not a no-op');
        // updateAndDraw with a bad dim -> no-op, state unchanged, no NaN
        e.clear();
        e.spawn(0.016, W, H);
        const before = e.liveCount();
        e.updateAndDraw(ctx, 0.016, d, H);
        e.updateAndDraw(ctx, 0.016, W, d);
        check(e.liveCount() === before, () => 'T1: updateAndDraw with bad dim mutated the pool');
        noNaN(e, 'dim=' + d);
    }

    // --- the door: non-finite config throws naming the key --------------------
    const finiteKeys = ['gravity', 'wind', 'maxSpeed', 'blurStrength', 'splashBounce',
        'splashSpread', 'splashLifeMin', 'splashLifeMax', 'density'];
    const bad = [NaN, Infinity, -Infinity];
    for (let k = 0; k < finiteKeys.length; k++) {
        const key = finiteKeys[k];
        for (let b = 0; b < bad.length; b++) {
            const v = bad[b];
            let threw = false, named = false;
            try { new RainEngine(100, { [key]: v }); }
            catch (err) { threw = true; named = String(err.message).includes(key); }
            check(threw, () => 'T1: config.' + key + '=' + v + ' was accepted (door open)');
            check(named, () => 'T1: throw for config.' + key + ' did not name the key');
        }
        // A NEGATIVE finite value is valid -- the door checks finiteness, not sign.
        let ok = true;
        try { new RainEngine(100, { [key]: -5 }); } catch { ok = false; }
        check(ok, () => 'T1: config.' + key + '=-5 (finite) was wrongly rejected');
    }
    // angle: non-finite throws when non-null; null and finite are accepted.
    for (let b = 0; b < bad.length; b++) {
        let threw = false;
        try { new RainEngine(100, { angle: bad[b] }); } catch { threw = true; }
        check(threw, () => 'T1: config.angle=' + bad[b] + ' was accepted (door open)');
    }
    let angleOk = true;
    try { new RainEngine(100, { angle: null }); new RainEngine(100, { angle: -Math.PI / 2 }); }
    catch { angleOk = false; }
    check(angleOk, () => 'T1: a valid angle (null or finite) was rejected');
}
