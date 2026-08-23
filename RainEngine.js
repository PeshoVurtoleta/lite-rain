/**
 * @zakkster/lite-rain
 * Zero-GC, SoA Environmental Rain Engine
 * Master-tier optimization: Precomputed physics constants, cached render buckets, responsive density, and terminal velocity bounds.
 */

import { toCssOklch } from '@zakkster/lite-color';

export const VERSION = '1.3.0';

/** Documented ceiling for maxParticles. Above this, the constructor throws. */
export const MAX_PARTICLES = 2000000;

/**
 * Maximum seconds a drop may spend falling (state 1) before it is recycled.
 * The positional cull only catches drops that LEAVE the box; a legal, finite
 * force field can hold a drop INSIDE the box with zero net motion forever
 * (gravity:0 + wind:0, angle:0 with gravity-derived speed 0, maxSpeed:0 + wind:0).
 * This age cap is the guarantee that bounds the pool under ANY finite field.
 * 12s is far beyond a normal fall -- even a far-depth (z=0.2) drop under default
 * gravity reaches the floor in ~1-2s -- so it never touches a real raindrop.
 * It reuses the `life` array (unused during state 1); not a config knob for R1.
 */
const MAX_FALL_LIFE = 12;

/**
 * Default angular frequency (rad/s) of the wind gust oscillator. 2*PI/3 gives a
 * ~3s swell period. The constructor default gustRate is `Math.fround(GUST_HZ)` so
 * a Float32-round-tripped read of the phase term is numerically identical.
 */
const TAU = Math.PI * 2;
const GUST_HZ = TAU / 3;

/** Ripple ring geometry (module consts, not config). */
const RIPPLE_SLOTS = 64;         // ring capacity; index with & RIPPLE_MASK
const RIPPLE_MASK = RIPPLE_SLOTS - 1;
const RIPPLE_LIFE0 = 0.6;        // seconds a ground ripple ring lives
const RIPPLE_R0 = 2;             // initial ring radius px (scaled by drop depth)
const RIPPLE_GROWTH = 60;        // px/s ring expansion

/** Config keys that must be finite numbers. Validated once, at construction. */
const FINITE_KEYS = [
    'gravity', 'wind', 'maxSpeed', 'blurStrength', 'splashBounce',
    'splashSpread', 'splashLifeMin', 'splashLifeMax', 'density', 'splashScale',
    'gust', 'gustRate'
];

/** Inline finite predicate -- no runtime dep. NaN, +/-Infinity and non-numbers fail. */
function isFiniteNumber(v) {
    return typeof v === 'number' && v - v === 0;
}

export class RainEngine {
    constructor(maxParticles = 8000, config = {}) {
        if (!Number.isInteger(maxParticles) || maxParticles < 1 || maxParticles > MAX_PARTICLES) {
            throw new RangeError(
                'RainEngine: maxParticles must be an integer in [1, ' + MAX_PARTICLES +
                '], got ' + maxParticles);
        }
        this.max = maxParticles;
        this.config = {
            gravity: 1500,        
            wind: 200,            
            density: 5.0,         
            maxSpeed: 2500,       // FIX 3: Terminal velocity bound
            blurStrength: 0.04,   // FIX 4: Exposed motion blur scalar
            splashBounce: 0.25,
            splashSpread: 200,
            splashLifeMin: 0.1,
            splashLifeMax: 0.3,
            splashScale: 1.2,     // R-10: splash base radius scalar (was hardcoded 1.2)
            angle: null,
            gust: 0,                          // R3: wind-gust amplitude (0 = off)
            gustRate: Math.fround(GUST_HZ),   // R3: gust oscillator frequency rad/s
            floorY: null,                     // R3: splash floor Y; null = use h
            splashDroplets: 0,                // R3: extra droplets per impact (0..3)
            ripples: false,                   // R3: ground ripple rings (strict bool)
            color: 'oklch(0.95 0.05 250)',
            rng: Math.random,
            ...config
        };

        // FIX R-02: the door. A non-finite config value poisons x/y/vy to NaN on
        // frame 1; since NaN >= h is false, poisoned drops never recycle and the
        // pool exhausts silently. Reject at construction, naming the offending key.
        for (let k = 0; k < FINITE_KEYS.length; k++) {
            const key = FINITE_KEYS[k];
            if (!isFiniteNumber(this.config[key])) {
                throw new RangeError(
                    'RainEngine: config.' + key + ' must be a finite number, got ' +
                    this.config[key]);
            }
        }
        if (this.config.angle !== null && !isFiniteNumber(this.config.angle)) {
            throw new RangeError(
                'RainEngine: config.angle must be a finite number or null, got ' +
                this.config.angle);
        }
        // R3 doors. floorY is null-or-finite (null = "use h"); splashDroplets is an
        // integer in 0..3; ripples is a STRICT boolean (a truthy non-bool is a bug,
        // not a yes). gust/gustRate finiteness is enforced by FINITE_KEYS above.
        if (this.config.floorY !== null && !isFiniteNumber(this.config.floorY)) {
            throw new RangeError(
                'RainEngine: config.floorY must be a finite number or null, got ' +
                this.config.floorY);
        }
        if (!Number.isInteger(this.config.splashDroplets) ||
            this.config.splashDroplets < 0 || this.config.splashDroplets > 3) {
            throw new RangeError(
                'RainEngine: config.splashDroplets must be an integer in [0, 3], got ' +
                this.config.splashDroplets);
        }
        if (typeof this.config.ripples !== 'boolean') {
            throw new RangeError(
                'RainEngine: config.ripples must be a boolean, got ' + this.config.ripples);
        }

        this.colorStr = typeof this.config.color === 'string' ? this.config.color : toCssOklch(this.config.color);

        this.x = new Float32Array(this.max);
        this.y = new Float32Array(this.max);
        this.vx = new Float32Array(this.max);
        this.vy = new Float32Array(this.max);
        this.z = new Float32Array(this.max);
        
        // Data-Oriented Precomputed Arrays
        this.gz = new Float32Array(this.max);    
        this.wz = new Float32Array(this.max);    
        this.bucket = new Uint8Array(this.max);  
        this.radius = new Float32Array(this.max); 
        this.tailMult = new Float32Array(this.max); // FIX 1: Cached perspective motion blur

        this.life = new Float32Array(this.max);
        this.state = new Uint8Array(this.max);

        this._destroyed = false;

        // R-05: dimension cache. areaModifier is recomputed only when (w,h) change.
        this._lastW = 0;
        this._lastH = 0;
        this._areaModifier = 0;

        // R-07: ring-cursor allocator. Persisted across spawns so low-occupancy
        // spawn is O(spawned) amortized rather than an O(max) scan from index 0.
        this._spawnCursor = 0;

        // R-08: persistent per-frame bin lists, allocated ONCE. updateAndDraw's
        // single physics pass appends each drop's FINAL-state index here, and the
        // render walks only these live indices -- never 0..max x4. Buffers never
        // grow (the T6 gate asserts their byteLength directly).
        this._streakIdx = [
            new Uint32Array(this.max),
            new Uint32Array(this.max),
            new Uint32Array(this.max),
        ];
        this._streakCount = new Uint32Array(3);
        this._splashIdx = new Uint32Array(this.max);
        this._splashCount = 0;

        this._buckets = [
            { id: 0, zAvg: 0.3 },
            { id: 1, zAvg: 0.55 },
            { id: 2, zAvg: 0.9 }
        ];

        // R3: frame-time accumulator for the gust oscillator. Advances every frame
        // UNCONDITIONALLY (determinism contract: the phase clock is not gated on the
        // feature; only the READ that consumes it is). Never a config knob.
        this._elapsed = 0;

        // R3: ground-ripple ring. Pre-allocated at construction ONLY when the
        // feature is on, so the OFF path carries no ripple buffers at all and the
        // three fields stay null (the draw/write gates test `!== null`). Never grows.
        if (this.config.ripples === true) {
            this._rippleX = new Float32Array(RIPPLE_SLOTS);
            this._rippleR = new Float32Array(RIPPLE_SLOTS);
            this._rippleLife = new Float32Array(RIPPLE_SLOTS);
        } else {
            this._rippleX = null;
            this._rippleR = null;
            this._rippleLife = null;
        }
        this._rippleHead = 0;
    }

    spawn(dt, w, h) {
        if (this._destroyed) return;
        // FIX R-03: clamp dt low as well as high. A zero/negative/NaN frame is a
        // no-op, not a reversed or poisoned integrator.
        if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
        // Fail closed on non-finite / non-positive dimensions -- never spawn a
        // pool poisoned to NaN or Infinity coordinates.
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

        // R-05 dimension cache: (w*h)/100000 only changes when (w,h) do. Recompute
        // on a dimension change, otherwise reuse the cached areaModifier.
        if (w !== this._lastW || h !== this._lastH) {
            this._lastW = w;
            this._lastH = h;
            this._areaModifier = (w * h) / 100000;
        }
        const targetSpawns = Math.floor(this._areaModifier * this.config.density * (dt * 60));
        if (targetSpawns <= 0) return;

        // R-09 hoist: lift the per-particle config reads to loop-top locals. Safe
        // because the R1 door froze config finiteness at construction; mutating
        // `config` mid-run is unsupported (these locals lag by up to a frame).
        const g = this.config.gravity;
        const wind = this.config.wind;
        const angle = this.config.angle;
        const rng = this.config.rng;
        const blurStrength = this.config.blurStrength;
        const angled = angle !== null;
        const cosA = angled ? Math.cos(angle) : 0;
        const sinA = angled ? Math.sin(angle) : 0;
        const speedBase = angled ? (g * 0.5) : 0;

        // Guard the derived spawn window: a finite gravity of 0 would make
        // h / gravity == Infinity and poison x to NaN. Fail closed to 0 (R1 guard).
        // R-04: clamp the non-zero branch to a sane multiple of w so drops are born
        // near-screen instead of arbitrarily far off under strong wind; the R-01
        // cull recycles any that still drift off. Keep the g===0 -> 0 fallback.
        const windOffset = (g !== 0) ? Math.min((h / g) * Math.abs(wind), w) : 0;
        const spawnWidth = w + windOffset * 2;

        const max = this.max;
        let spawned = 0;
        let cursor = this._spawnCursor;
        // R-07 ring cursor: scan from the persisted cursor and wrap. Bound the probe
        // count to exactly `max` so a FULL pool terminates in one lap -- not an
        // infinite wrap -- then persist the cursor for the next call.
        for (let n = 0; n < max; n++) {
            const i = cursor;
            cursor = cursor + 1;
            if (cursor >= max) cursor = 0;
            if (this.state[i] !== 0) continue;

            this.state[i] = 1;

            this.x[i] = rng() * spawnWidth - windOffset;
            this.y[i] = -50 - rng() * 100;

            const z = 0.2 + rng() * 0.8;
            this.z[i] = z;

            this.gz[i] = g * z;
            this.wz[i] = wind * z;
            this.bucket[i] = z < 0.4 ? 0 : z < 0.7 ? 1 : 2;

            // FIX 1 & 4 Applied: Precalculate the exact line stretch per drop
            this.tailMult[i] = blurStrength * z;

            // R-01 age cap: seed the time-aloft budget. The splash transition
            // overwrites life[i] with the splash lifetime, so there is no clash.
            this.life[i] = MAX_FALL_LIFE;

            if (angled) {
                const speed = speedBase * z;
                this.vx[i] = cosA * speed;
                this.vy[i] = sinA * speed;
            } else {
                this.vx[i] = this.wz[i];
                this.vy[i] = this.gz[i] * 0.5;
            }

            if (++spawned >= targetSpawns) break;
        }
        this._spawnCursor = cursor;
    }

    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        // FIX R-03: clamp dt low as well as high (also rejects NaN dt).
        if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
        // Fail closed on non-finite / non-positive dimensions.
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

        // R-09 hoist: lift the loop-invariant config reads and derived constants to
        // frame-top locals. Safe because the R1 door froze config finiteness at
        // construction; mutating `config` mid-run is unsupported (these locals lag
        // by up to a frame). FIX 2: the splash-life division is done strictly once.
        const angle = this.config.angle;
        const angled = angle !== null;
        const maxSpeed = this.config.maxSpeed;
        const splashBounce = this.config.splashBounce;
        const splashSpread = this.config.splashSpread;
        const splashLifeMin = this.config.splashLifeMin;
        const splashLifeMax = this.config.splashLifeMax;
        const splashScale = this.config.splashScale; // R-10: read once, not per splash
        const rng = this.config.rng;
        const invSplashLifeMax = 1.0 / splashLifeMax;

        // R3 hoists. `fy` folds floorY into the floor local: null -> the existing h.
        const gust = this.config.gust;
        const gustRate = this.config.gustRate;
        const floorY = this.config.floorY;
        const splashDroplets = this.config.splashDroplets;
        const fy = floorY !== null ? floorY : h;
        const rippleX = this._rippleX; // null when the feature is off
        const rippleR = this._rippleR;
        const rippleLife = this._rippleLife;
        const max = this.max;

        // Advance the gust phase clock ONCE per frame, unconditionally. The feature
        // READ below is guarded; the accumulator is not (determinism contract).
        this._elapsed += dt;
        let windPulse = 0;
        if (gust !== 0) windPulse = Math.sin(this._elapsed * gustRate) * gust * dt;

        // R-08: bind the persistent bin lists to locals and reset their counts at
        // frame top. Each drop's index is appended AFTER its transitions resolve,
        // keyed on its FINAL state this frame -- state 0 (culled/aged) is not binned.
        const streak0 = this._streakIdx[0];
        const streak1 = this._streakIdx[1];
        const streak2 = this._streakIdx[2];
        const splashIdx = this._splashIdx;
        let c0 = 0, c1 = 0, c2 = 0, cs = 0;

        // --- 1. GLOBAL PHYSICS PASS (single pass; bins as it goes) ---
        for (let i = 0; i < this.max; i++) {
            const s = this.state[i];
            if (s === 0) continue;

            if (s === 1) {
                if (angled === false) {
                    this.vx[i] += this.wz[i] * 0.5 * dt;
                }
                // R3 gust: a frame-constant horizontal pulse (0 when gust is off).
                this.vx[i] += windPulse;

                this.vy[i] += this.gz[i] * dt;

                // FIX 3 Applied: Terminal velocity clamping (scaled by depth!)
                const terminalVel = maxSpeed * this.z[i];
                if (this.vy[i] > terminalVel) this.vy[i] = terminalVel;

                this.x[i] += this.vx[i] * dt;
                this.y[i] += this.vy[i] * dt;

                if (this.y[i] >= fy) {
                    this.y[i] = fy;
                    this.state[i] = 2;

                    // R-10: splashScale replaces the hardcoded 1.2 base (default 1.2
                    // preserves the exact prior radius).
                    this.radius[i] = this.z[i] * (splashScale + (Math.abs(this.vy[i]) / 2000));
                    this.vy[i] = -this.vy[i] * splashBounce * rng();
                    this.vx[i] = (rng() - 0.5) * splashSpread * this.z[i];
                    this.life[i] = splashLifeMin + rng() * (splashLifeMax - splashLifeMin);
                    // Final state 2 this frame -> splash list.
                    splashIdx[cs++] = i;

                    // R3 droplets. Emit N tiny state-2 particles into free slots via
                    // the shared spawn ring. The _spawnCursor read/write is STRICTLY
                    // inside this guard so the OFF path (splashDroplets === 0) never
                    // perturbs slot assignment -> bit-identical to v1.2.0. A droplet
                    // landing at a slot the physics pass has ALREADY passed (j <= i)
                    // is binned here; one landing ahead (j > i) is left for the main
                    // loop to bin -- so every state-2 slot is binned EXACTLY once and
                    // the full-scan render (T5) still matches.
                    if (splashDroplets !== 0) {
                        let cur = this._spawnCursor;
                        for (let d = 0; d < splashDroplets; d++) {
                            let j = -1;
                            for (let n = 0; n < max; n++) {
                                const cand = cur;
                                cur = cur + 1; if (cur >= max) cur = 0;
                                if (this.state[cand] === 0) { j = cand; break; }
                            }
                            if (j === -1) break; // no free slot -> respect max
                            this.state[j] = 2;
                            this.z[j] = this.z[i];
                            this.gz[j] = this.gz[i];
                            this.x[j] = this.x[i];
                            this.y[j] = fy;
                            this.vx[j] = (rng() - 0.5) * splashSpread * this.z[i];
                            this.vy[j] = this.vy[i] * rng();
                            this.radius[j] = this.z[i] * splashScale * 0.5;
                            this.life[j] = splashLifeMin + rng() * (splashLifeMax - splashLifeMin);
                            if (j <= i) splashIdx[cs++] = j;
                        }
                        this._spawnCursor = cur;
                    }

                    // R3 ripples. Record the impact into the pre-allocated ring; the
                    // draw happens AFTER the splash loop, fully independent of the
                    // pool. Gate on the ring being non-null (feature on).
                    if (rippleX !== null) {
                        const head = this._rippleHead;
                        rippleX[head] = this.x[i];
                        rippleR[head] = RIPPLE_R0 * this.z[i];
                        rippleLife[head] = RIPPLE_LIFE0;
                        this._rippleHead = (head + 1) & RIPPLE_MASK;
                    }
                } else if (!(this.x[i] >= -200 && this.x[i] <= w + 200 && this.y[i] >= -200)) {
                    // FIX R-01: after integration, cull a state-1 drop that left the
                    // simulable region (snow's 200px margins) back to free. Floor
                    // hits above take precedence. The negated-range form is NaN-safe:
                    // NaN fails every comparison, so !(...) is true and a poisoned
                    // drop is recycled instead of leaking forever. A culled drop is
                    // state 0 and is NOT binned below, so it is never drawn.
                    this.state[i] = 0;
                } else if ((this.life[i] -= dt) <= 0) {
                    // R-01 age cap: the positional cull only catches drops that
                    // LEAVE the box. A drop frozen INSIDE it (zero net motion under a
                    // legal finite field: gravity:0+wind:0, angle:0, maxSpeed:0) never
                    // leaves and never falls. Time aloft is bounded so it recycles.
                    // Aged out -> state 0 -> NOT binned.
                    this.state[i] = 0;
                } else {
                    // Survived as a streak this frame -> bin into its depth bucket.
                    const b = this.bucket[i];
                    if (b === 0) streak0[c0++] = i;
                    else if (b === 1) streak1[c1++] = i;
                    else streak2[c2++] = i;
                }
            }
            else { // s === 2
                this.life[i] -= dt;
                if (this.life[i] <= 0) {
                    this.state[i] = 0;
                    continue;
                }
                this.vy[i] += this.gz[i] * dt;
                this.x[i] += this.vx[i] * dt;
                this.y[i] += this.vy[i] * dt;
                if (this.y[i] > fy) this.y[i] = fy;
                // Still a splash this frame -> splash list.
                splashIdx[cs++] = i;
            }
        }

        this._streakCount[0] = c0;
        this._streakCount[1] = c1;
        this._streakCount[2] = c2;
        this._splashCount = cs;

        // --- 2. BUCKETED RENDER PIPELINE (walks ONLY binned live indices) ---
        ctx.lineCap = 'round';
        ctx.strokeStyle = this.colorStr;
        ctx.fillStyle = this.colorStr;

        const streakCount = this._streakCount;
        // Render Streaks (Using fully precomputed arrays)
        for (let bi = 0; bi < 3; bi++) {
            const bucket = this._buckets[bi];
            const list = this._streakIdx[bi];
            const count = streakCount[bi];
            ctx.globalAlpha = bucket.zAvg * 0.6;
            ctx.lineWidth = bucket.zAvg * 2.0;
            ctx.beginPath();

            for (let k = 0; k < count; k++) {
                const i = list[k];
                ctx.moveTo(this.x[i], this.y[i]);
                ctx.lineTo(this.x[i] - this.vx[i] * this.tailMult[i], this.y[i] - this.vy[i] * this.tailMult[i]);
            }
            ctx.stroke();
        }

        // Render Splashes (Using multiplication instead of division)
        for (let k = 0; k < cs; k++) {
            const i = splashIdx[k];
            ctx.globalAlpha = (this.life[i] * invSplashLifeMax) * this.z[i];
            ctx.beginPath();
            ctx.arc(this.x[i], this.y[i], this.radius[i], 0, TAU);
            ctx.fill();
        }

        // --- 3. GROUND RIPPLES (independent of the pool; one path) ---
        // Age every live ring, expand its radius, and stroke ALL of them in a single
        // beginPath()/stroke(). Gated on the ring being allocated (feature on).
        if (rippleX !== null) {
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let k = 0; k < RIPPLE_SLOTS; k++) {
                let lifeK = rippleLife[k];
                if (lifeK <= 0) continue;
                lifeK -= dt;
                if (lifeK <= 0) { rippleLife[k] = 0; continue; }
                rippleLife[k] = lifeK;
                const r = rippleR[k] + RIPPLE_GROWTH * dt;
                rippleR[k] = r;
                const rx = rippleX[k];
                ctx.moveTo(rx + r, fy);
                ctx.ellipse(rx, fy, r, r * 0.3, 0, 0, TAU);
            }
            ctx.stroke();
        }

        ctx.globalAlpha = 1.0;
    }

    /**
     * O(max) live-particle count (state != 0). Test/debug telemetry for the
     * conservation invariant -- NOT for a hot path.
     */
    liveCount() {
        if (this._destroyed) return 0;
        const s = this.state;
        let n = 0;
        for (let i = 0; i < this.max; i++) if (s[i] !== 0) n++;
        return n;
    }

    clear() {
        if (this._destroyed) return;
        this.state.fill(0);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.clear();
        this.x = null; this.y = null; this.vx = null; this.vy = null;
        this.z = null; this.gz = null; this.wz = null; this.bucket = null;
        this.radius = null; this.tailMult = null; this.life = null; this.state = null;
        // Release the R-08 bin scratch too.
        this._streakIdx = null; this._streakCount = null; this._splashIdx = null;
        // R3: release the ripple ring.
        this._rippleX = null; this._rippleR = null; this._rippleLife = null;
    }
}

/**
 * R3 presets. Partial configs spread into `new RainEngine(max, { ...preset })`;
 * every value is finite and passes the constructor door. `storm` is the showcase:
 * high wind, a slanted fixed angle, and a live wind gust. Frozen (and each nested
 * config frozen) so a preset cannot be mutated in place.
 */
export const RAIN_PRESETS = Object.freeze({
    drizzle: Object.freeze({ gravity: 900, wind: 80, density: 2, maxSpeed: 1500 }),
    steady: Object.freeze({ gravity: 1500, wind: 200, density: 5 }),
    downpour: Object.freeze({ gravity: 2000, wind: 350, density: 14, splashSpread: 260 }),
    storm: Object.freeze({
        gravity: 2200, wind: 1200, angle: 0.4, gust: 300, density: 22, splashSpread: 320,
    }),
});