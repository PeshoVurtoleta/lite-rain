/**
 * @zakkster/lite-rain — TypeScript Declarations
 */

export interface RainConfig {
    /** Downward acceleration in px/s². Default: 1500 */
    gravity?: number;
    /** Horizontal wind in px/s. Positive = right. Default: 200 */
    wind?: number;
    /** Spawn rate multiplier (scales with canvas area). Default: 5.0 */
    density?: number;
    /** Terminal velocity cap in px/s (depth-scaled). Default: 2500 */
    maxSpeed?: number;
    /** Velocity-direction streak length multiplier. Default: 0.04 */
    blurStrength?: number;
    /** Splash bounce energy retention (0–1). Default: 0.25 */
    splashBounce?: number;
    /** Splash horizontal spread in px. Default: 200 */
    splashSpread?: number;
    /** Minimum splash lifetime in seconds. Default: 0.1 */
    splashLifeMin?: number;
    /** Maximum splash lifetime in seconds. Default: 0.3 */
    splashLifeMax?: number;
    /** Fixed rain angle in radians. null = gravity + wind (natural). Default: null */
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

    constructor(maxParticles?: number, config?: RainConfig);

    /**
     * Spawn new raindrops. Call every frame before updateAndDraw().
     * Spawn count auto-scales with canvas area × density × dt.
     * @param dt Delta time in seconds
     * @param w  Logical canvas width
     * @param h  Logical canvas height
     */
    spawn(dt: number, w: number, h: number): void;

    /**
     * Update physics and render all rain particles.
     * Does NOT clear the canvas — rain is an overlay. Caller clears.
     * Call spawn() before this each frame.
     * @param ctx Canvas 2D context
     * @param dt  Delta time in seconds
     * @param w   Logical canvas width
     * @param h   Logical canvas height (also used as floor Y for splashes)
     */
    updateAndDraw(ctx: CanvasRenderingContext2D, dt: number, w: number, h: number): void;

    /** Kill all particles immediately. */
    clear(): void;

    /** Release all typed arrays. Idempotent. */
    destroy(): void;
}
