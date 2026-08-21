/**
 * @zakkster/lite-rain
 * Zero-GC, SoA Environmental Rain Engine
 * Master-tier optimization: Precomputed physics constants, cached render buckets, responsive density, and terminal velocity bounds.
 */

import { toCssOklch } from '@zakkster/lite-color';

export const VERSION = '1.1.0';

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

/** Config keys that must be finite numbers. Validated once, at construction. */
const FINITE_KEYS = [
    'gravity', 'wind', 'maxSpeed', 'blurStrength', 'splashBounce',
    'splashSpread', 'splashLifeMin', 'splashLifeMax', 'density'
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
            angle: null,
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

        this._buckets = [
            { id: 0, zAvg: 0.3 },
            { id: 1, zAvg: 0.55 },
            { id: 2, zAvg: 0.9 } 
        ];
    }

    spawn(dt, w, h) {
        if (this._destroyed) return;
        // FIX R-03: clamp dt low as well as high. A zero/negative/NaN frame is a
        // no-op, not a reversed or poisoned integrator.
        if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
        // Fail closed on non-finite / non-positive dimensions -- never spawn a
        // pool poisoned to NaN or Infinity coordinates.
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

        const areaModifier = (w * h) / 100000;
        const targetSpawns = Math.floor(areaModifier * this.config.density * (dt * 60));
        
        let spawned = 0;
        if (targetSpawns <= 0) return;

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) {
                this.state[i] = 1; 
                
                // Guard the derived spawn window: a finite gravity of 0 would make
                // h / gravity == Infinity and poison x to NaN. Fail closed to 0.
                // (Full on-screen spawn-window sizing under gravity:0 is R-04 / R2.)
                const g = this.config.gravity;
                const windOffset = (g !== 0) ? (h / g) * Math.abs(this.config.wind) : 0;
                this.x[i] = this.config.rng() * (w + windOffset * 2) - windOffset;
                this.y[i] = -50 - this.config.rng() * 100;
                
                this.z[i] = 0.2 + this.config.rng() * 0.8;
                
                this.gz[i] = this.config.gravity * this.z[i];
                this.wz[i] = this.config.wind * this.z[i];
                this.bucket[i] = this.z[i] < 0.4 ? 0 : this.z[i] < 0.7 ? 1 : 2;
                
                // FIX 1 & 4 Applied: Precalculate the exact line stretch per drop
                this.tailMult[i] = this.config.blurStrength * this.z[i];

                // R-01 age cap: seed the time-aloft budget. The splash transition
                // overwrites life[i] with the splash lifetime, so there is no clash.
                this.life[i] = MAX_FALL_LIFE;
                
                if (this.config.angle !== null) {
                    const speed = (this.config.gravity * 0.5) * this.z[i];
                    this.vx[i] = Math.cos(this.config.angle) * speed;
                    this.vy[i] = Math.sin(this.config.angle) * speed;
                } else {
                    this.vx[i] = this.wz[i];
                    this.vy[i] = this.gz[i] * 0.5; 
                }

                if (++spawned >= targetSpawns) return;
            }
        }
    }

    updateAndDraw(ctx, dt, w, h) {
        if (this._destroyed) return;
        // FIX R-03: clamp dt low as well as high (also rejects NaN dt).
        if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
        // Fail closed on non-finite / non-positive dimensions.
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;

        // FIX 2 Applied: Calculate division strictly once per frame
        const invSplashLifeMax = 1.0 / this.config.splashLifeMax;

        // --- 1. GLOBAL PHYSICS PASS ---
        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) continue;

            if (this.state[i] === 1) {
                if (this.config.angle === null) {
                    this.vx[i] += this.wz[i] * 0.5 * dt;
                }

                this.vy[i] += this.gz[i] * dt;

                // FIX 3 Applied: Terminal velocity clamping (scaled by depth!)
                const terminalVel = this.config.maxSpeed * this.z[i];
                if (this.vy[i] > terminalVel) this.vy[i] = terminalVel;

                this.x[i] += this.vx[i] * dt;
                this.y[i] += this.vy[i] * dt;

                if (this.y[i] >= h) {
                    this.y[i] = h;
                    this.state[i] = 2;

                    this.radius[i] = this.z[i] * (1.2 + (Math.abs(this.vy[i]) / 2000));
                    this.vy[i] = -this.vy[i] * this.config.splashBounce * this.config.rng();
                    this.vx[i] = (this.config.rng() - 0.5) * this.config.splashSpread * this.z[i];
                    this.life[i] = this.config.splashLifeMin + this.config.rng() * (this.config.splashLifeMax - this.config.splashLifeMin);
                } else if (!(this.x[i] >= -200 && this.x[i] <= w + 200 && this.y[i] >= -200)) {
                    // FIX R-01: after integration, cull a state-1 drop that left the
                    // simulable region (snow's 200px margins) back to free. Floor
                    // hits above take precedence. The negated-range form is NaN-safe:
                    // NaN fails every comparison, so !(...) is true and a poisoned
                    // drop is recycled instead of leaking forever. The render pass
                    // is a separate state===1 loop, so a culled drop is never drawn.
                    this.state[i] = 0;
                } else if ((this.life[i] -= dt) <= 0) {
                    // R-01 age cap: the positional cull only catches drops that
                    // LEAVE the box. A drop frozen INSIDE it (zero net motion under a
                    // legal finite field: gravity:0+wind:0, angle:0, maxSpeed:0) never
                    // leaves and never falls. Time aloft is bounded so it recycles.
                    this.state[i] = 0;
                }
            }
            else if (this.state[i] === 2) {
                this.life[i] -= dt;
                if (this.life[i] <= 0) {
                    this.state[i] = 0;
                    continue;
                }
                this.vy[i] += this.gz[i] * dt; 
                this.x[i] += this.vx[i] * dt;
                this.y[i] += this.vy[i] * dt;
                if (this.y[i] > h) this.y[i] = h; 
            }
        }

        // --- 2. BUCKETED RENDER PIPELINE ---
        ctx.lineCap = 'round';
        ctx.strokeStyle = this.colorStr;
        ctx.fillStyle = this.colorStr;

        // Render Streaks (Using fully precomputed arrays)
        for (const bucket of this._buckets) {
            ctx.globalAlpha = bucket.zAvg * 0.6; 
            ctx.lineWidth = bucket.zAvg * 2.0;   
            ctx.beginPath();
            
            for (let i = 0; i < this.max; i++) {
                if (this.state[i] === 1 && this.bucket[i] === bucket.id) {
                    ctx.moveTo(this.x[i], this.y[i]);
                    ctx.lineTo(this.x[i] - this.vx[i] * this.tailMult[i], this.y[i] - this.vy[i] * this.tailMult[i]);
                }
            }
            ctx.stroke(); 
        }

        // Render Splashes (Using multiplication instead of division)
        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 2) {
                ctx.globalAlpha = (this.life[i] * invSplashLifeMax) * this.z[i]; 
                ctx.beginPath();
                ctx.arc(this.x[i], this.y[i], this.radius[i], 0, Math.PI * 2);
                ctx.fill();
            }
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
    }
}