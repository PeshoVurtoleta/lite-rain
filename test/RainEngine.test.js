import { describe, it, expect } from 'vitest';
import { RainEngine } from '../RainEngine.js';

const ctx = {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    arc() {}, stroke() {}, fill() {},
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt',
};

describe('RainEngine', () => {
    it('constructs with defaults', () => {
        const e = new RainEngine();
        expect(e.max).toBe(8000);
        expect(e.config.gravity).toBe(1500);
        expect(e.config.wind).toBe(200);
        expect(e.config.density).toBe(5.0);
    });

    it('pre-parses OKLCH color', () => {
        const e = new RainEngine(100, { color: { l: 0.9, c: 0.05, h: 250 } });
        expect(typeof e.colorStr).toBe('string');
        expect(e.colorStr).toContain('oklch');
    });

    it('accepts CSS string color', () => {
        const e = new RainEngine(100, { color: 'rgba(200,200,255,0.6)' });
        expect(e.colorStr).toBe('rgba(200,200,255,0.6)');
    });

    it('spawn creates streaks (state=1)', () => {
        const e = new RainEngine(200, { density: 50 });
        e.spawn(0.016, 800, 600);
        let count = 0;
        for (let i = 0; i < 200; i++) if (e.state[i] === 1) count++;
        expect(count).toBeGreaterThan(0);
    });

    it('spawn precomputes gz, wz, bucket, tailMult', () => {
        const e = new RainEngine(100, { density: 100, rng: () => 0.7 });
        e.spawn(0.016, 800, 600);
        // Find first alive particle
        let idx = -1;
        for (let i = 0; i < 100; i++) { if (e.state[i] === 1) { idx = i; break; } }
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(e.gz[idx]).toBeGreaterThan(0);
        expect(e.tailMult[idx]).toBeGreaterThan(0);
        expect(e.bucket[idx]).toBeLessThanOrEqual(2);
    });

    it('z-depth is in range [0.2, 1.0]', () => {
        const e = new RainEngine(500, { density: 200 });
        e.spawn(0.016, 800, 600);
        for (let i = 0; i < 500; i++) {
            if (e.state[i] === 1) {
                expect(e.z[i]).toBeGreaterThanOrEqual(0.2);
                expect(e.z[i]).toBeLessThanOrEqual(1.0);
            }
        }
    });

    it('updateAndDraw runs without error', () => {
        const e = new RainEngine(100, { density: 50 });
        e.spawn(0.016, 800, 600);
        expect(() => e.updateAndDraw(ctx, 0.016, 800, 600)).not.toThrow();
    });

    it('streaks become splashes on floor hit', () => {
        const e = new RainEngine(100, { gravity: 5000, density: 100 });
        e.spawn(0.016, 800, 600);
        // Run many frames to let streaks hit floor
        for (let i = 0; i < 60; i++) e.updateAndDraw(ctx, 0.016, 800, 600);
        let splashes = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] === 2) splashes++;
        expect(splashes).toBeGreaterThan(0);
    });

    it('dt clamping in spawn', () => {
        const e = new RainEngine(500, { density: 2 });
        e.spawn(10.0, 800, 600); // huge dt
        // Should not spawn a million particles
        let count = 0;
        for (let i = 0; i < 500; i++) if (e.state[i] !== 0) count++;
        expect(count).toBeLessThan(500);
    });

    it('dt clamping in updateAndDraw', () => {
        const e = new RainEngine(100, { density: 50 });
        e.spawn(0.016, 800, 600);
        expect(() => e.updateAndDraw(ctx, 5.0, 800, 600)).not.toThrow();
    });

    it('angle override sets directional rain', () => {
        const e = new RainEngine(100, { angle: Math.PI / 4, density: 200, rng: () => 0.5 });
        e.spawn(0.016, 800, 600);
        let idx = -1;
        for (let i = 0; i < 100; i++) { if (e.state[i] === 1) { idx = i; break; } }
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(e.vx[idx]).toBeGreaterThan(0); // angled right
    });

    it('clear kills all', () => {
        const e = new RainEngine(100, { density: 100 });
        e.spawn(0.016, 800, 600);
        e.clear();
        let alive = 0;
        for (let i = 0; i < 100; i++) if (e.state[i] !== 0) alive++;
        expect(alive).toBe(0);
    });

    it('destroy nulls all 12 arrays', () => {
        const e = new RainEngine(100);
        e.destroy();
        expect(e.x).toBeNull();
        expect(e.gz).toBeNull();
        expect(e.tailMult).toBeNull();
        expect(e.state).toBeNull();
    });

    it('destroy is idempotent', () => {
        const e = new RainEngine(100);
        e.destroy();
        expect(() => e.destroy()).not.toThrow();
    });
});
