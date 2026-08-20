/**
 * @zakkster/lite-rain
 * Zero-GC, SoA Environmental Rain Engine
 * Master-tier optimization: Precomputed physics constants, cached render buckets, responsive density, and terminal velocity bounds.
 */

import { toCssOklch } from '@zakkster/lite-color';

export class RainEngine {
    constructor(maxParticles = 8000, config = {}) {
        this.max = maxParticles;
        this.config = {
            gravity: 1500,        
            wind: 200,            
            density: 5.0,         
            maxSpeed: 2500,       // ⭐ FIX 3: Terminal velocity bound
            blurStrength: 0.04,   // ⭐ FIX 4: Exposed motion blur scalar
            splashBounce: 0.25,   
            splashSpread: 200,    
            splashLifeMin: 0.1,   
            splashLifeMax: 0.3,
            angle: null,          
            color: 'oklch(0.95 0.05 250)', 
            rng: Math.random,     
            ...config
        };

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
        this.tailMult = new Float32Array(this.max); // ⭐ FIX 1: Cached perspective motion blur

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
        if (dt > 0.1) dt = 0.1;
        
        const areaModifier = (w * h) / 100000;
        const targetSpawns = Math.floor(areaModifier * this.config.density * (dt * 60));
        
        let spawned = 0;
        if (targetSpawns <= 0) return;

        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) {
                this.state[i] = 1; 
                
                const windOffset = (h / this.config.gravity) * Math.abs(this.config.wind);
                this.x[i] = this.config.rng() * (w + windOffset * 2) - windOffset;
                this.y[i] = -50 - this.config.rng() * 100;
                
                this.z[i] = 0.2 + this.config.rng() * 0.8;
                
                this.gz[i] = this.config.gravity * this.z[i];
                this.wz[i] = this.config.wind * this.z[i];
                this.bucket[i] = this.z[i] < 0.4 ? 0 : this.z[i] < 0.7 ? 1 : 2;
                
                // ⭐ FIX 1 & 4 Applied: Precalculate the exact line stretch per drop
                this.tailMult[i] = this.config.blurStrength * this.z[i];
                
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
        if (dt > 0.1) dt = 0.1;

        // ⭐ FIX 2 Applied: Calculate division strictly once per frame
        const invSplashLifeMax = 1.0 / this.config.splashLifeMax;

        // --- 1. GLOBAL PHYSICS PASS ---
        for (let i = 0; i < this.max; i++) {
            if (this.state[i] === 0) continue;

            if (this.state[i] === 1) {
                if (this.config.angle === null) {
                    this.vx[i] += this.wz[i] * 0.5 * dt; 
                }
                
                this.vy[i] += this.gz[i] * dt; 
                
                // ⭐ FIX 3 Applied: Terminal velocity clamping (scaled by depth!)
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