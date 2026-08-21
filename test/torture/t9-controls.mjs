/**
 * T9 -- controls. Every gate must be provably able to fail.
 *
 * Deliberately-broken variants run IN PROCESS; each corresponding gate must flag
 * its variant. If a control slips through, T9 itself fails the run -- a gate that
 * cannot fail is decorative.
 *
 * Whole-suite control: RAIN_TORTURE_BREAK=1 injects retained allocations into
 * T6's hot loop so the alloc gate rejects and the process exits non-zero. T9
 * covers the same alloc lane here so a plain run already proves the gate bites.
 */

import { RainEngine } from '../../RainEngine.js';
import { runOpsGate, die, makeCtx } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export function run() {
    const ctx = makeCtx();

    // Control 1 -- the T6 alloc gate. A hot body that retains an allocation every
    // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0).
    const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (report.ok) die('T9 control: an allocating hot loop passed the zero-alloc gate');
    leak.length = 0; // release the control's garbage

    // Control 2 -- the T3 conservation gate. Disable the R-01 off-screen cull
    // (pre-R1 physics: only a floor hit recycles) and run negative gravity: the
    // pool MUST pin at max. If it does not, `liveCount() < max` cannot fail.
    {
        const e = new RainEngine(300, { gravity: -1500, wind: 0, density: 20, color: '#fff' });
        const brokenStep = () => {
            // Pre-R1 state-1 integration with NO off-screen cull.
            for (let i = 0; i < e.max; i++) {
                if (e.state[i] !== 1) continue;
                e.vy[i] += e.gz[i] * 0.016;
                e.x[i] += e.vx[i] * 0.016;
                e.y[i] += e.vy[i] * 0.016;
                if (e.y[i] >= 600) e.state[i] = 0; // only the floor recycles
            }
        };
        for (let f = 0; f < 400; f++) { e.spawn(0.016, 800, 600); brokenStep(); }
        if (e.liveCount() !== e.max) {
            die('T9 control: cull-disabled negative gravity did NOT pin the pool to max (' +
                e.liveCount() + '/' + e.max + ') -- the T3 conservation gate cannot fail');
        }
    }

    // Control 3 -- the door (T1). Prove the door bites in BOTH directions: a
    // non-finite config THROWS (a stuck-closed door would also throw on a valid
    // config -- so we assert a finite config does NOT throw). A door stuck open
    // fails the first check; a door stuck closed fails the second.
    {
        let threwBad = false;
        try { new RainEngine(100, { gravity: NaN }); } catch { threwBad = true; }
        if (!threwBad) die('T9 control: the door accepted a NaN gravity (stuck open)');

        let threwGood = false;
        try { new RainEngine(100, { gravity: 1500, wind: 200, density: 5 }); } catch { threwGood = true; }
        if (threwGood) die('T9 control: the door rejected a fully-finite config (stuck closed)');
    }

    // Control 4 -- the NaN-safe cull backstop (T3, Defect-2). The negated-range
    // cull recycles a drop carrying a non-finite coordinate; the pre-fix form
    // (`x < -200 || x > w + 200 || y < -200`) is false on NaN and would LEAK it.
    // Seed a NaN drop behind the door's back and assert it is recycled -- so a
    // regression to the non-NaN-safe cull is caught here.
    {
        const p = new RainEngine(60, { density: 90, gravity: 1500, color: '#fff' });
        p.spawn(0.016, 800, 600);
        let poisoned = 0;
        for (let i = 0; i < p.max; i++) if (p.state[i] === 1) { p.x[i] = NaN; p.y[i] = NaN; poisoned++; }
        if (poisoned === 0) die('T9 control: could not seed a poisoned drop');
        for (let f = 0; f < 5; f++) p.updateAndDraw(ctx, 0.016, 800, 600);
        let stillNaN = 0;
        for (let i = 0; i < p.max; i++) if (p.state[i] === 1 && !Number.isFinite(p.y[i])) stillNaN++;
        if (stillNaN !== 0) {
            die('T9 control: ' + stillNaN + ' NaN drop(s) survived the cull -- the NaN-safe ' +
                'negated-range test regressed and the pool would leak poison');
        }

        // Prove the control is not vacuous: a drop the plain range test WOULD catch
        // (finite, off-screen) is culled too.
        const q = new RainEngine(10, { density: 200, gravity: 1500, color: '#fff' });
        q.spawn(0.016, 800, 600);
        let put = -1;
        for (let i = 0; i < q.max; i++) if (q.state[i] === 1) { q.x[i] = 5000; q.y[i] = 100; put = i; break; }
        if (put === -1) die('T9 control: could not seed an off-screen drop');
        q.updateAndDraw(ctx, 0.016, 800, 600);
        if (q.state[put] === 1) die('T9 control: an off-screen finite drop was not culled');
    }

    // Control 5 -- the age cap (T3, R-01 frozen-drop leak). Disable the age cap
    // (integrate + positional cull ONLY, no life decrement) under a zero-net-motion
    // field: a drop frozen INSIDE the box never leaves, so the positional cull
    // never fires and the pool MUST pin at max and never drain. If it drains
    // without the age cap, the frozen-drop scenarios in T3 cannot fail.
    {
        const e = new RainEngine(300, { gravity: 0, wind: 0, density: 20, color: '#fff' });
        const brokenStep = () => {
            for (let i = 0; i < e.max; i++) {
                if (e.state[i] !== 1) continue;
                // frozen field: vx=vy=0, integration moves nothing
                e.x[i] += e.vx[i] * 0.016;
                e.y[i] += e.vy[i] * 0.016;
                // positional cull only -- NO age cap
                if (!(e.x[i] >= -200 && e.x[i] <= 800 + 200 && e.y[i] >= -200)) e.state[i] = 0;
            }
        };
        for (let f = 0; f < 300; f++) { e.spawn(0.016, 800, 600); brokenStep(); }
        if (e.liveCount() !== e.max) {
            die('T9 control: age-cap-disabled frozen field did not fill the pool (' +
                e.liveCount() + '/' + e.max + ')');
        }
        // spawn-free drain: without the age cap, frozen drops never leave.
        for (let f = 0; f < 2000; f++) brokenStep();
        if (e.liveCount() !== e.max) {
            die('T9 control: age-cap-disabled frozen drops drained (' + e.liveCount() +
                '/' + e.max + ') -- the T3 age-cap gate cannot fail');
        }
    }
}
