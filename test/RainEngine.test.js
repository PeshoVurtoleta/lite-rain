import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RainEngine, VERSION, MAX_PARTICLES } from '../RainEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    arc() {}, stroke() {}, fill() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

function run(e, frames, dt, w, h) {
    for (let f = 0; f < frames; f++) { e.spawn(dt, w, h); e.updateAndDraw(ctx, dt, w, h); }
}

// ---------------------------------------------------------------------------
// Ported vitest suite (15 assertions preserved)
// ---------------------------------------------------------------------------

test('constructs with defaults', () => {
    const e = new RainEngine();
    assert.equal(e.max, 8000);
    assert.equal(e.config.gravity, 1500);
    assert.equal(e.config.wind, 200);
    assert.equal(e.config.density, 5.0);
});

test('pre-parses OKLCH color', () => {
    const e = new RainEngine(100, { color: { l: 0.9, c: 0.05, h: 250 } });
    assert.equal(typeof e.colorStr, 'string');
    assert.ok(e.colorStr.includes('oklch'));
});

test('accepts CSS string color', () => {
    const e = new RainEngine(100, { color: 'rgba(200,200,255,0.6)' });
    assert.equal(e.colorStr, 'rgba(200,200,255,0.6)');
});

test('spawn creates streaks (state=1)', () => {
    const e = new RainEngine(200, { density: 50 });
    e.spawn(0.016, 800, 600);
    let count = 0;
    for (let i = 0; i < 200; i++) if (e.state[i] === 1) count++;
    assert.ok(count > 0);
});

test('spawn precomputes gz, wz, bucket, tailMult', () => {
    const e = new RainEngine(100, { density: 100, rng: () => 0.7 });
    e.spawn(0.016, 800, 600);
    let idx = -1;
    for (let i = 0; i < 100; i++) { if (e.state[i] === 1) { idx = i; break; } }
    assert.ok(idx >= 0);
    assert.ok(e.gz[idx] > 0);
    assert.ok(e.tailMult[idx] > 0);
    assert.ok(e.bucket[idx] <= 2);
});

test('z-depth is in range [0.2, 1.0]', () => {
    const e = new RainEngine(500, { density: 200 });
    e.spawn(0.016, 800, 600);
    for (let i = 0; i < 500; i++) {
        if (e.state[i] === 1) {
            assert.ok(e.z[i] >= 0.2);
            assert.ok(e.z[i] <= 1.0);
        }
    }
});

test('updateAndDraw runs without error', () => {
    const e = new RainEngine(100, { density: 50 });
    e.spawn(0.016, 800, 600);
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
});

test('streaks become splashes on floor hit', () => {
    const e = new RainEngine(100, { gravity: 5000, density: 100 });
    e.spawn(0.016, 800, 600);
    for (let i = 0; i < 60; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
    let splashes = 0;
    for (let i = 0; i < 100; i++) if (e.state[i] === 2) splashes++;
    assert.ok(splashes > 0);
});

test('dt clamping in spawn', () => {
    const e = new RainEngine(500, { density: 2 });
    e.spawn(10.0, 800, 600); // huge dt
    let count = 0;
    for (let i = 0; i < 500; i++) if (e.state[i] !== 0) count++;
    assert.ok(count < 500);
});

test('dt clamping in updateAndDraw', () => {
    const e = new RainEngine(100, { density: 50 });
    e.spawn(0.016, 800, 600);
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 5.0, 800, 600));
});

test('angle override sets directional rain', () => {
    const e = new RainEngine(100, { angle: Math.PI / 4, density: 200, rng: () => 0.5 });
    e.spawn(0.016, 800, 600);
    let idx = -1;
    for (let i = 0; i < 100; i++) { if (e.state[i] === 1) { idx = i; break; } }
    assert.ok(idx >= 0);
    assert.ok(e.vx[idx] > 0); // angled right
});

test('clear kills all', () => {
    const e = new RainEngine(100, { density: 100 });
    e.spawn(0.016, 800, 600);
    e.clear();
    let alive = 0;
    for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
    assert.equal(alive, 0);
});

test('destroy nulls all 12 arrays', () => {
    const e = new RainEngine(100);
    e.destroy();
    assert.equal(e.x, null);
    assert.equal(e.gz, null);
    assert.equal(e.tailMult, null);
    assert.equal(e.state, null);
});

test('destroy is idempotent', () => {
    const e = new RainEngine(100);
    e.destroy();
    assert.doesNotThrow(() => e.destroy());
});

// ---------------------------------------------------------------------------
// R1 correctness regressions (failing before this release, passing after)
// ---------------------------------------------------------------------------

test('R-01 negative gravity: upward drops are culled, pool is not exhausted', () => {
    const e = new RainEngine(500, { gravity: -1500, wind: 0, density: 20, color: '#fff' });
    run(e, 400, 0.016, 800, 600);
    // Was 500/500 (pinned at max). Now bounded well below capacity.
    assert.ok(e.liveCount() < e.max, 'liveCount ' + e.liveCount() + ' pinned at max');
    // No live drop simulated far above the top margin.
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] === 1) assert.ok(e.y[i] >= -200, 'drop leaked above top margin: y=' + e.y[i]);
    }
});

test('R-01 upward angle: pool is not exhausted', () => {
    const e = new RainEngine(500, { angle: -Math.PI / 2, density: 20, color: '#fff' });
    run(e, 400, 0.016, 800, 600);
    assert.ok(e.liveCount() < e.max, 'liveCount ' + e.liveCount() + ' pinned at max');
});

test('R-01 extreme wind: no live drop simulated past w+200', () => {
    const e = new RainEngine(500, { wind: 20000, gravity: 300, density: 10, color: '#fff' });
    run(e, 300, 0.016, 800, 600);
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] === 1) assert.ok(e.x[i] <= 800 + 200, 'drop leaked past right margin: x=' + e.x[i]);
    }
});

test('R-01 frozen field: zero-net-motion drops are age-capped, not leaked', () => {
    // Each is a legal, finite config the door accepts, yet leaves drops with
    // vx==vy==0 that never leave the box. Without the age cap they pin at max.
    const configs = [
        { gravity: 0, wind: 0, density: 20, color: '#fff' },
        { gravity: 0, angle: 0, density: 20, color: '#fff' },
        { maxSpeed: 0, wind: 0, gravity: 1500, density: 20, color: '#fff' },
    ];
    for (const cfg of configs) {
        const e = new RainEngine(400, cfg);
        for (let f = 0; f < 300; f++) { e.spawn(0.016, 800, 600); e.updateAndDraw(ctx, 0.016, 800, 600); }
        // Confirm the drops really are frozen (the positional cull cannot catch them).
        let idx = -1;
        for (let i = 0; i < e.max; i++) if (e.state[i] === 1) { idx = i; break; }
        assert.ok(idx >= 0, 'no live drop for ' + JSON.stringify(cfg));
        assert.equal(e.vx[idx], 0, 'expected frozen vx for ' + JSON.stringify(cfg));
        assert.equal(e.vy[idx], 0, 'expected frozen vy for ' + JSON.stringify(cfg));
        // Spawn-free frames must drain the pool to 0 via the 12s age cap
        // (12 / 0.016 = 750 frames; 1200 is a safe margin).
        for (let f = 0; f < 1200; f++) e.updateAndDraw(ctx, 0.016, 800, 600);
        assert.equal(e.liveCount(), 0, 'frozen pool did not drain for ' + JSON.stringify(cfg));
    }
});

test('R-01 conservation: a normal frame after adversarial run still recycles', () => {
    const e = new RainEngine(300, { gravity: -1500, density: 20, color: '#fff' });
    run(e, 200, 0.016, 800, 600);
    const before = e.liveCount();
    // Switch to normal downward gravity by rebuilding forces is out of scope;
    // instead prove a subsequent frame keeps the count bounded (does not climb to max).
    e.spawn(0.016, 800, 600);
    e.updateAndDraw(ctx, 0.016, 800, 600);
    assert.ok(e.liveCount() < e.max, 'count climbed to max: ' + e.liveCount());
    assert.ok(before < e.max);
});

test('R-02 door: non-finite config throws naming the key', () => {
    assert.throws(() => new RainEngine(100, { gravity: NaN }), /gravity/);
    assert.throws(() => new RainEngine(100, { wind: Infinity }), /wind/);
    assert.throws(() => new RainEngine(100, { maxSpeed: -Infinity }), /maxSpeed/);
    assert.throws(() => new RainEngine(100, { density: NaN }), /density/);
    assert.throws(() => new RainEngine(100, { splashLifeMax: NaN }), /splashLifeMax/);
    assert.throws(() => new RainEngine(100, { angle: NaN }), /angle/);
});

test('R-02 door: angle null stays valid; no NaN reaches the pool', () => {
    const e = new RainEngine(100, { angle: null, density: 100 });
    run(e, 60, 0.016, 800, 600);
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            assert.ok(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]) && Number.isFinite(e.vy[i]),
                'NaN reached the pool at ' + i);
        }
    }
});

test('R-03 dt: negative and NaN dt are no-ops (state unchanged)', () => {
    const e = new RainEngine(100, { density: 50 });
    e.spawn(0.016, 800, 600);
    const y0 = e.y.slice();
    const s0 = e.state.slice();
    e.updateAndDraw(ctx, -0.05, 800, 600);
    e.updateAndDraw(ctx, NaN, 800, 600);
    for (let i = 0; i < e.max; i++) {
        assert.equal(e.state[i], s0[i]);
        assert.equal(e.y[i], y0[i]);
    }
});

test('R-03 dt: negative dt in spawn is a no-op', () => {
    const e = new RainEngine(200, { density: 50 });
    e.spawn(-0.05, 800, 600);
    assert.equal(e.liveCount(), 0);
});

test('R-13 constructor: bad maxParticles throws a library RangeError', () => {
    for (const bad of [0, -1, 2.5, NaN, Infinity, 1e12]) {
        assert.throws(() => new RainEngine(bad), RangeError, 'maxParticles=' + bad);
    }
    assert.equal(MAX_PARTICLES, 2000000);
    assert.throws(() => new RainEngine(MAX_PARTICLES + 1), RangeError);
    assert.doesNotThrow(() => new RainEngine(1));
});

test('VERSION is exported and matches 1.2.0', () => {
    assert.equal(VERSION, '1.2.0');
});

// ---------------------------------------------------------------------------
// QA boundary matrix: 0 / 1 / N-1 / N / N+1 / empty / null / undefined / NaN /
// -0 / duplicate dispose / dispose-during-iteration / re-entrant write / an
// adversarial case the planner did not think of.
// (0, N+1, NaN, Infinity, duplicate-dispose already pinned above.)
// ---------------------------------------------------------------------------

test('boundary: maxParticles = -0 throws (Number.isInteger(-0) is true, -0 < 1)', () => {
    assert.throws(() => new RainEngine(-0), RangeError);
});

test('boundary: maxParticles = MAX_PARTICLES (N) constructs; MAX_PARTICLES - 1 (N-1) constructs', () => {
    const eN = new RainEngine(MAX_PARTICLES, { density: 0.001 });
    assert.equal(eN.max, MAX_PARTICLES);
    eN.destroy();
    const eNm1 = new RainEngine(MAX_PARTICLES - 1, { density: 0.001 });
    assert.equal(eNm1.max, MAX_PARTICLES - 1);
    eNm1.destroy();
});

test('boundary: config = null behaves exactly like the default config (empty/null)', () => {
    const e = new RainEngine(10, null);
    assert.equal(e.config.gravity, 1500);
    assert.equal(e.config.wind, 200);
});

test('boundary: config = undefined (explicit) behaves like the default config', () => {
    const e = new RainEngine(10, undefined);
    assert.equal(e.config.gravity, 1500);
});

test('boundary: dt = -0 is a no-op in both spawn and updateAndDraw', () => {
    const e = new RainEngine(50, { density: 50, color: '#fff' });
    e.spawn(-0, 800, 600);
    assert.equal(e.liveCount(), 0, 'spawn(-0) created drops -- not a no-op');

    e.spawn(0.016, 800, 600);
    const y0 = e.y.slice();
    const s0 = e.state.slice();
    e.updateAndDraw(ctx, -0, 800, 600);
    for (let i = 0; i < e.max; i++) {
        assert.equal(e.state[i], s0[i]);
        assert.equal(e.y[i], y0[i]);
    }
});

test('boundary: liveCount() returns 0 after destroy (documented, not a raw null-read crash)', () => {
    const e = new RainEngine(50, { density: 50, color: '#fff' });
    e.spawn(0.016, 800, 600);
    e.destroy();
    assert.equal(e.liveCount(), 0);
});

test('boundary: spawn/updateAndDraw/clear are silent no-ops after destroy', () => {
    const e = new RainEngine(50, { density: 50, color: '#fff' });
    e.destroy();
    assert.doesNotThrow(() => e.spawn(0.016, 800, 600));
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
    assert.doesNotThrow(() => e.clear());
    assert.doesNotThrow(() => e.destroy()); // duplicate dispose, again, post no-op path
});

test('boundary: dispose-during-iteration (destroy() re-entered from rng() mid-spawn) fails loud, not silent', () => {
    // A pathological rng that destroys its own engine mid-spawn. This is caller
    // misuse (no realistic rng does this), but the observed contract is a raw,
    // immediate crash -- never a silently corrupted or half-written pool. Pinned
    // so a future change cannot regress this into silent corruption.
    let n = 0;
    const e = new RainEngine(50, { density: 100, color: '#fff', rng: () => {
        n++;
        if (n === 3) e.destroy();
        return Math.random();
    } });
    assert.throws(() => e.spawn(0.016, 800, 600), TypeError);
    assert.equal(e._destroyed, true);
});

test('boundary: dispose-during-iteration (destroy() re-entered from ctx.stroke mid-render) fails loud, not silent', () => {
    const e = new RainEngine(50, { density: 100, color: '#fff' });
    e.spawn(0.016, 800, 600);
    let strokeCalls = 0;
    const disposingCtx = {
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
        stroke() { strokeCalls++; if (strokeCalls === 1) e.destroy(); },
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
    };
    assert.throws(() => e.updateAndDraw(disposingCtx, 0.016, 800, 600), TypeError);
});

test('boundary: re-entrant spawn() from within rng() does not corrupt the pool', () => {
    // rng() is invoked per-particle inside spawn's loop body; a re-entrant nested
    // spawn() call must not double-allocate the slot currently being written (its
    // state is already marked non-zero before rng() runs) and must leave every
    // live drop finite.
    let depth = 0;
    const e = new RainEngine(200, { density: 20, color: '#fff', rng: () => {
        depth++;
        if (depth === 1) e.spawn(0.016, 800, 600);
        depth--;
        return Math.random();
    } });
    assert.doesNotThrow(() => e.spawn(0.016, 800, 600));
    let seen = new Set();
    for (let i = 0; i < e.max; i++) {
        seen.add(e.state[i]);
        if (e.state[i] !== 0) {
            assert.ok(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]),
                're-entrant spawn left a non-finite coordinate at ' + i);
        }
    }
    for (const s of seen) assert.ok(s === 0 || s === 1 || s === 2, 'invalid state value ' + s);
});

test('boundary: re-entrant updateAndDraw() from within rng() during a floor hit does not corrupt the pool', () => {
    const e = new RainEngine(50, { gravity: 5000, density: 100, color: '#fff' });
    e.spawn(0.016, 800, 600);
    for (let i = 0; i < 60; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
    let reentered = false;
    e.config.rng = () => {
        if (!reentered) {
            reentered = true;
            e.updateAndDraw(ctx, 0.016, 800, 600);
        }
        return Math.random();
    };
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            assert.ok(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]),
                're-entrant updateAndDraw left a non-finite coordinate at ' + i);
        }
    }
});

test('adversarial (not in the brief): ctx.stroke() throwing mid-render leaves physics state committed and finite; next frame recovers', () => {
    // The physics pass runs to completion BEFORE any render call. A canvas
    // context that throws partway through the bucketed render loop must not
    // leave the SIMULATION half-stepped -- only the draw for this frame is lost.
    const e = new RainEngine(300, { density: 60, color: '#fff' });
    e.spawn(0.016, 800, 600);
    const before = e.liveCount();
    let strokeCalls = 0;
    const badCtx = {
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
        stroke() { strokeCalls++; if (strokeCalls === 2) throw new Error('canvas context lost'); },
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
    };
    assert.throws(() => e.updateAndDraw(badCtx, 0.016, 800, 600), /canvas context lost/);
    // Physics already committed for every particle: count is exactly what a
    // normal frame would have produced, and every live drop is still finite.
    assert.equal(e.liveCount(), before);
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            assert.ok(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]),
                'physics pass left a non-finite coordinate after a render-time throw');
        }
    }
    // A subsequent normal frame with a healthy ctx recovers cleanly.
    assert.doesNotThrow(() => { e.spawn(0.016, 800, 600); e.updateAndDraw(ctx, 0.016, 800, 600); });
});

// ---------------------------------------------------------------------------
// Determinism (future T8's job; pinned here now per the R1 brief)
// ---------------------------------------------------------------------------

function seededRng(seed) {
    let s = seed >>> 0 || 1;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

test('Determinism: two engines with matched seeded rng produce byte-identical state after N frames', () => {
    const cfg = { density: 20, gravity: 1500, wind: 300, color: '#fff' };
    const eA = new RainEngine(300, { ...cfg, rng: seededRng(12345) });
    const eB = new RainEngine(300, { ...cfg, rng: seededRng(12345) });
    for (let f = 0; f < 200; f++) {
        eA.spawn(0.016, 800, 600); eA.updateAndDraw(ctx, 0.016, 800, 600);
        eB.spawn(0.016, 800, 600); eB.updateAndDraw(ctx, 0.016, 800, 600);
    }
    // Sanity: the run actually produced a live, mixed-state pool (not vacuously
    // both-empty, which would make byte-identity trivial).
    assert.ok(eA.liveCount() > 0 && eA.liveCount() < eA.max);
    for (let i = 0; i < eA.max; i++) {
        assert.equal(eA.x[i], eB.x[i], 'x mismatch at ' + i);
        assert.equal(eA.y[i], eB.y[i], 'y mismatch at ' + i);
        assert.equal(eA.vx[i], eB.vx[i], 'vx mismatch at ' + i);
        assert.equal(eA.vy[i], eB.vy[i], 'vy mismatch at ' + i);
        assert.equal(eA.state[i], eB.state[i], 'state mismatch at ' + i);
        assert.equal(eA.life[i], eB.life[i], 'life mismatch at ' + i);
    }
});

// ---------------------------------------------------------------------------
// MAX_FALL_LIFE (age cap) boundary -- reviewer NIT
// ---------------------------------------------------------------------------

test('MAX_FALL_LIFE boundary: a normal drop at default gravity splashes well before the 12s cap', () => {
    // Worst case (farthest/slowest drop, z=0.2) under default gravity reaches the
    // floor in ~1-2s. Assert the first splash happens well inside a 3.2s window
    // (200 frames @ dt=0.016) -- far short of the 12s cap -- proving a realistic
    // fall is never truncated mid-flight by the age cap.
    const e = new RainEngine(50, { density: 30, color: '#fff' }); // gravity: 1500 (default)
    e.spawn(0.016, 800, 600);
    let splashFrame = -1;
    for (let f = 0; f < 200; f++) {
        e.updateAndDraw(ctx, 0.016, 800, 600);
        let splashed = false;
        for (let i = 0; i < e.max; i++) if (e.state[i] === 2) { splashed = true; break; }
        if (splashed) { splashFrame = f; break; }
    }
    assert.ok(splashFrame >= 0 && splashFrame < 200,
        'no splash within 3.2s (200 frames) -- a normal drop should never approach the 12s cap');
});

// ---------------------------------------------------------------------------
// R2 QA -- boundary coverage for the hot-path wave's new surface:
// splashScale door, ring-cursor conservation, dim cache, R-04 spawn clamp,
// determinism across the refactor.
// ---------------------------------------------------------------------------

function cyclingRng(vals) {
    let i = 0;
    return () => vals[(i++) % vals.length];
}

test('R2 splashScale door: NaN throws naming splashScale', () => {
    assert.throws(() => new RainEngine(100, { splashScale: NaN }), /splashScale/);
});

test('R2 splashScale door: Infinity and -Infinity throw naming splashScale', () => {
    assert.throws(() => new RainEngine(100, { splashScale: Infinity }), /splashScale/);
    assert.throws(() => new RainEngine(100, { splashScale: -Infinity }), /splashScale/);
});

test('R2 splashScale door: a finite splashScale is accepted', () => {
    assert.doesNotThrow(() => new RainEngine(100, { splashScale: 2.5 }));
    assert.doesNotThrow(() => new RainEngine(100, { splashScale: 0 }));
});

test('R2 splashScale: default engine produces the SAME splash radius as explicit splashScale:1.2 for a deterministic impact', () => {
    // Force a fully deterministic impact: zero gz (no gravity accel this frame),
    // zero vx, a known vy, and y placed one integration step below the floor.
    // radius = z * (splashScale + abs(impactVy) / 2000) is read from vy BEFORE
    // the bounce overwrite, so this pins the exact impact velocity.
    function forceSplash(extraConfig) {
        const e = new RainEngine(20, {
            density: 1, gravity: 1500, wind: 0, maxSpeed: 5000,
            splashBounce: 0.25, rng: () => 0.5, color: '#fff', ...extraConfig,
        });
        e.spawn(0.016, 800, 600);
        let idx = -1;
        for (let i = 0; i < e.max; i++) if (e.state[i] === 1) { idx = i; break; }
        assert.ok(idx >= 0, 'no live drop to force a splash on');
        e.z[idx] = 0.6; e.gz[idx] = 0; e.vx[idx] = 0; e.vy[idx] = 500;
        e.x[idx] = 400; e.y[idx] = 599;
        e.updateAndDraw(ctx, 0.016, 800, 600);
        assert.equal(e.state[idx], 2, 'forced impact did not splash');
        return { radius: e.radius[idx], z: e.z[idx] };
    }
    const def = forceSplash({});
    const explicit = forceSplash({ splashScale: 1.2 });
    assert.equal(def.radius, explicit.radius, 'default splashScale radius differs from explicit 1.2');
    const expected = def.z * (1.2 + 500 / 2000);
    assert.ok(Math.abs(def.radius - expected) < 1e-4,
        'radius=' + def.radius + ' expected=' + expected);
});

test('R2 ring cursor: full-fill / clear / refill cycles never strand a slot', () => {
    // A density high enough that one spawn() call fills the whole (small) pool.
    // Repeating fill -> clear -> fill proves the persisted cursor keeps finding
    // every free slot regardless of where it was left by the prior cycle.
    const e = new RainEngine(50, { density: 1000, color: '#fff' });
    for (let cycle = 0; cycle < 5; cycle++) {
        e.spawn(0.1, 800, 600);
        assert.equal(e.liveCount(), 50, 'cycle ' + cycle + ' did not fill the pool: ' + e.liveCount());
        e.clear();
        assert.equal(e.liveCount(), 0, 'cycle ' + cycle + ' did not drain after clear()');
    }
});

test('R2 ring cursor: a FULL pool spawn is a no-op that terminates and touches no slot', () => {
    const e = new RainEngine(30, { density: 1000, color: '#fff' });
    e.state.fill(1); // simulate a fully occupied pool without going through spawn()
    const xBefore = e.x.slice();
    const start = Date.now();
    e.spawn(0.016, 800, 600);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, 'full-pool spawn did not terminate promptly: ' + elapsed + 'ms');
    assert.equal(e.liveCount(), 30, 'full-pool spawn changed occupancy');
    for (let i = 0; i < e.max; i++) {
        assert.equal(e.x[i], xBefore[i], 'full-pool spawn wrote to occupied slot ' + i);
    }
});

test('R2 dim cache: spawn count at a different (w,h) is consistent with the new area (cache invalidates)', () => {
    const density = 5;
    const eA = new RainEngine(5000, { density, rng: () => 0.5, color: '#fff' });
    eA.spawn(0.016, 800, 600);
    const n1 = eA.liveCount();

    const eB = new RainEngine(5000, { density, rng: () => 0.5, color: '#fff' });
    eB.spawn(0.016, 800, 600);   // same first call, primes the cache the same way
    eB.spawn(0.016, 1600, 1200); // 4x area on the SAME engine -- must invalidate
    const n2 = eB.liveCount() - n1;

    const expected1 = Math.floor(((800 * 600) / 100000) * density * (0.016 * 60));
    const expected2 = Math.floor(((1600 * 1200) / 100000) * density * (0.016 * 60));
    assert.equal(n1, Math.min(expected1, eA.max), 'first-call spawn count mismatch');
    assert.equal(n2, Math.min(expected2, eB.max - n1), 'dim-change spawn count mismatch -- stale cache?');
    assert.ok(n2 > n1, 'larger area should spawn strictly more: n1=' + n1 + ' n2=' + n2);
});

test('R2 dim cache: repeated spawn at the SAME (w,h) reuses the cached modifier -- equal counts for equal inputs', () => {
    const e = new RainEngine(3000, { density: 5, rng: () => 0.5, color: '#fff' });
    e.spawn(0.016, 800, 600);
    const n1 = e.liveCount();
    assert.equal(e._lastW, 800);
    assert.equal(e._lastH, 600);
    assert.equal(e._areaModifier, (800 * 600) / 100000);

    e.spawn(0.016, 800, 600); // second call, SAME dims -- cache-hit path
    const n2 = e.liveCount() - n1;
    // Cache fields must be untouched by a same-dims call (no recompute happened).
    assert.equal(e._lastW, 800);
    assert.equal(e._lastH, 600);
    assert.equal(e._areaModifier, (800 * 600) / 100000);
    assert.equal(n2, n1, 'second spawn at identical dims produced a different count: ' + n1 + ' vs ' + n2);
});

test('R2-04 clamp: strong wind + weak gravity spawns every drop within [-w, 2w], not the old unbounded band', () => {
    const w = 800, h = 600;
    // Old formula: windOffset = (h/g)*|wind| = (600/300)*20000 = 40000 -> band
    // [-40000, 40800]. New clamp: windOffset = min(40000, w) = 800 -> band [-800, 1600].
    const e = new RainEngine(4000, {
        gravity: 300, wind: 20000, density: 300, color: '#fff',
        rng: cyclingRng([0, 1e-6, 0.1, 0.25, 0.5, 0.75, 0.9, 1 - 1e-6]),
    });
    e.spawn(0.1, w, h);
    let count = 0;
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] === 1) {
            count++;
            assert.ok(e.x[i] >= -w - 1e-6 && e.x[i] <= 2 * w + 1e-6,
                'R-04 clamp violated: x=' + e.x[i] + ' outside [' + (-w) + ',' + (2 * w) + ']');
            // Also prove it is INSIDE the old, unclamped 80,800px band's extremes
            // is not sufficient on its own -- assert it's nowhere near them.
            assert.ok(e.x[i] > -40000 && e.x[i] < 40800,
                'sanity: x within the old band does not prove the new clamp (expected anyway)');
        }
    }
    assert.ok(count > 0, 'no drops spawned to check');
});

test('R2-04 / R1 guard: gravity:0 still spawns finite on-screen x (windOffset falls back to 0)', () => {
    const w = 800, h = 600;
    const e = new RainEngine(500, { gravity: 0, wind: 20000, density: 50, rng: () => 0.5, color: '#fff' });
    e.spawn(0.1, w, h);
    let count = 0;
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] === 1) {
            count++;
            assert.ok(Number.isFinite(e.x[i]), 'x is not finite with gravity:0');
            assert.ok(e.x[i] >= 0 && e.x[i] <= w, 'x outside [0,w]: x=' + e.x[i]);
        }
    }
    assert.ok(count > 0, 'no drops spawned to check');
});

test('R2 determinism across the refactor: two engines, same seeded rng, byte-identical state across varying dims', () => {
    // Do NOT assert against a hardcoded v1.1.0 slot layout -- the ring cursor
    // legitimately changed slot assignment. This is engine-vs-engine only, and
    // additionally stresses the dim cache by varying (w,h) frame to frame.
    const cfg = { density: 15, gravity: 1500, wind: 300, splashScale: 1.5, color: '#fff' };
    const eA = new RainEngine(400, { ...cfg, rng: seededRng(999) });
    const eB = new RainEngine(400, { ...cfg, rng: seededRng(999) });
    const sizes = [[800, 600], [1024, 768], [640, 480], [1920, 1080]];
    for (let f = 0; f < 240; f++) {
        const [w, h] = sizes[f % sizes.length];
        eA.spawn(0.016, w, h); eA.updateAndDraw(ctx, 0.016, w, h);
        eB.spawn(0.016, w, h); eB.updateAndDraw(ctx, 0.016, w, h);
    }
    assert.ok(eA.liveCount() > 0 && eA.liveCount() < eA.max);
    for (let i = 0; i < eA.max; i++) {
        assert.equal(eA.x[i], eB.x[i], 'x mismatch at ' + i);
        assert.equal(eA.y[i], eB.y[i], 'y mismatch at ' + i);
        assert.equal(eA.vx[i], eB.vx[i], 'vx mismatch at ' + i);
        assert.equal(eA.vy[i], eB.vy[i], 'vy mismatch at ' + i);
        assert.equal(eA.state[i], eB.state[i], 'state mismatch at ' + i);
        assert.equal(eA.life[i], eB.life[i], 'life mismatch at ' + i);
    }
});

test('R2 adversarial (not in the brief): re-entrant clear() from rng() mid-spawn does not desync the ring cursor', () => {
    // clear() zeroes every state but does NOT reset _spawnCursor. A pathological
    // rng() that clears the pool mid-spawn stresses the persisted ring cursor:
    // it must stay a valid index and subsequent spawns must still be finite and
    // bounded, not corrupt or hang.
    let n = 0;
    const e = new RainEngine(80, { density: 60, color: '#fff', rng: () => {
        n++;
        if (n === 5) e.clear();
        return Math.random();
    } });
    assert.doesNotThrow(() => e.spawn(0.016, 800, 600));
    assert.ok(e._spawnCursor >= 0 && e._spawnCursor < e.max,
        '_spawnCursor out of range: ' + e._spawnCursor);
    for (let i = 0; i < e.max; i++) {
        if (e.state[i] !== 0) {
            assert.ok(Number.isFinite(e.x[i]) && Number.isFinite(e.y[i]),
                'non-finite state after re-entrant clear() at ' + i);
        }
    }
    // Recovery: a subsequent normal cycle still works and stays bounded.
    e.spawn(0.016, 800, 600);
    assert.doesNotThrow(() => e.updateAndDraw(ctx, 0.016, 800, 600));
    assert.ok(e.liveCount() <= e.max);
});

test('MAX_FALL_LIFE boundary: degenerate low gravity on a tall canvas hits the age cap, not the floor', () => {
    // The reviewer's documented degenerate corner: gravity <= ~100 on a canvas
    // tall enough that the drop physically cannot reach h within 12s. The ONLY
    // path back to state 0 here is the age cap (x/vx stay 0 -> never culled
    // positionally; y only grows and starts > -200 -> never culled; y never
    // reaches the huge h -> never splashes).
    const H = 200000;
    const e = new RainEngine(20, { gravity: 50, wind: 0, density: 10, color: '#fff', rng: () => 0.5 });
    e.spawn(0.016, 800, H);
    let idx = -1;
    for (let i = 0; i < e.max; i++) if (e.state[i] === 1) { idx = i; break; }
    assert.ok(idx >= 0, 'no live drop spawned');
    for (let f = 0; f < 800; f++) { // 12.8s -- past the cap
        e.updateAndDraw(ctx, 0.016, 800, H);
        if (e.state[idx] === 0 || e.state[idx] === 2) break;
    }
    assert.equal(e.state[idx], 0,
        'drop did not recycle via the age cap (state=' + e.state[idx] + ', y=' + e.y[idx] + ')');
});
