/**
 * @zakkster/lite-rain -- TypeScript Declarations
 */

/** Current library version. Kept in sync with package.json and llms.txt. */
export declare const VERSION: string;

/** Documented ceiling for maxParticles; the constructor throws above it. */
export declare const MAX_PARTICLES: number;

export interface RainConfig {
    /** Downward acceleration in px/s^2. Must be finite. Default: 1500 */
    gravity?: number;
    /** Horizontal wind in px/s. Positive = right. Must be finite. Default: 200 */
    wind?: number;
    /** Spawn rate multiplier (scales with canvas area). Must be finite. Default: 5.0 */
    density?: number;
    /** Terminal velocity cap in px/s (depth-scaled). Must be finite. Default: 2500 */
    maxSpeed?: number;
    /** Velocity-direction streak length multiplier. Must be finite. Default: 0.04 */
    blurStrength?: number;
    /** Splash bounce energy retention (0-1). Must be finite. Default: 0.25 */
    splashBounce?: number;
    /** Splash horizontal spread in px. Must be finite. Default: 200 */
    splashSpread?: number;
    /** Minimum splash lifetime in seconds. Must be finite. Default: 0.1 */
    splashLifeMin?: number;
    /** Maximum splash lifetime in seconds. Must be finite. Default: 0.3 */
    splashLifeMax?: number;
    /** Splash base radius scalar: radius = z * (splashScale + abs(vy)/2000). Must be finite. Default: 1.2 */
    splashScale?: number;
    /** Fixed rain angle in radians. null = gravity + wind (natural). Finite when non-null. Default: null */
    angle?: number | null;
    /** Rain color as OKLCH object { l, c, h } or CSS string. Default: 'oklch(0.95 0.05 250)' */
    color?: { l: number; c: number; h: number } | string;
    /** Random number generator () => number [0, 1). Default: Math.random */
    rng?: () => number;
}

export declare class RainEngine {
    readonly max: number;
    config: Required<RainConfig>;
    colorStr: string;

    x: Float32Array | null;
    y: Float32Array | null;
    vx: Float32Array | null;
    vy: Float32Array | null;
    z: Float32Array | null;
    gz: Float32Array | null;
    wz: Float32Array | null;
    bucket: Uint8Array | null;
    radius: Float32Array | null;
    tailMult: Float32Array | null;
    life: Float32Array | null;
    state: Uint8Array | null;

    /**
     * @param maxParticles Pool capacity. Must be an integer in [1, MAX_PARTICLES];
     *                     throws a RangeError otherwise.
     * @param config       Engine config. Every numeric force key must be finite
     *                     (angle finite when non-null); a non-finite value throws
     *                     a RangeError naming the key.
     */
    constructor(maxParticles?: number, config?: RainConfig);

    /**
     * Spawn new raindrops. Call every frame before updateAndDraw().
     * Spawn count auto-scales with canvas area x density x dt.
     * A dt <= 0 or non-finite dt, or a non-finite / non-positive w or h, is a no-op.
     * @param dt Delta time in seconds
     * @param w  Logical canvas width
     * @param h  Logical canvas height
     */
    spawn(dt: number, w: number, h: number): void;

    /**
     * Update physics and render all rain particles.
     * Does NOT clear the canvas -- rain is an overlay. Caller clears.
     * Call spawn() before this each frame. A dt <= 0 or non-finite dt clamps to a
     * no-op step; a non-finite / non-positive w or h is a no-op. A state-1 drop
     * that leaves the region (x < -200 || x > w + 200 || y < -200) is recycled.
     * @param ctx Canvas 2D context
     * @param dt  Delta time in seconds
     * @param w   Logical canvas width
     * @param h   Logical canvas height (also used as floor Y for splashes)
     */
    updateAndDraw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number): void;

    /** O(max) count of live particles (state != 0). Test/debug telemetry, not a hot path. */
    liveCount(): number;

    /** Kill all particles immediately. */
    clear(): void;

    /** Release all typed arrays. Idempotent. */
    destroy(): void;
}
