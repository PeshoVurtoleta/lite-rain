export interface OklchColor {
    l: number;
    c: number;
    h: number;
    a?: number;
}

/** Linearly interpolates between two OKLCH colors with safe clamping. */
export declare const lerpOklch: (a: OklchColor, b: OklchColor, t: number) => OklchColor;
/** Linearly interpolates between two OKLCH colors with safe clamping, Zero-GC. */
export declare const lerpOklchTo: (a: OklchColor, b: OklchColor, t: number, out: OklchColor) => OklchColor;
/** Formats an OKLCH object to a CSS string. */
export declare const toCssOklch: (color: OklchColor) => string;
/**
 * Parse a CSS Color 4 oklch() string. Supports numbers, percentages (L/C/A),
 * `none` channels, deg/rad/grad/turn hue, the `/ alpha` slash form, leading-dot
 * numbers and flexible whitespace. Omitted alpha -> 1; explicit `none` -> 0.
 * Throws on malformed input. Returned `a` is always defined.
 */
export declare const parseOklch: (str: string) => Required<OklchColor>;
/** Multi-stop gradient evaluation with optional easing. */
export declare const multiStopGradient: (colors: OklchColor[], t: number, ease?: (t: number) => number) => OklchColor;
/** Multi-stop gradient evaluation with optional easing, Zero-GC */
export declare const multiStopGradientTo: (colors: OklchColor[], t: number, out: OklchColor, ease?: (t: number) => number) => OklchColor;
/** Creates a reusable gradient sampler function. */
export declare const createGradient: (colors: OklchColor[], ease?: (t: number) => number) => (t: number) => OklchColor;
/** Reverses a color array without mutation. */
export declare const reverseGradient: (colors: OklchColor[]) => OklchColor[];
/** Picks a random color from a gradient using an RNG with .next(). */
export declare const randomFromGradient: (colors: OklchColor[], rng: { next(): number }) => OklchColor;

/** Zero-GC OKLCH -> normalized sRGB RGBA (0-1). Writes into `out` at `offset`. */
export declare const toRgbTo: <T extends Float32Array | Float64Array | number[]>(color: OklchColor, out: T, offset?: number) => T;
/** Zero-GC OKLCH -> sRGB bytes (0-255). Writes into `out` at `offset`. Canvas ImageData ready. */
export declare const toRgbBytesTo: <T extends Uint8Array | Uint8ClampedArray | number[]>(color: OklchColor, out: T, offset?: number) => T;
/** Floats per stop in a bakeGradient LUT: l, c, h, a. */
export declare const BAKE_STRIDE: 4;
/** Bake a multi-stop gradient into a packed Float32Array LUT (BAKE_STRIDE floats per stop: l, c, h, a). */
export declare const bakeGradient: (colors: OklchColor[], steps: number, out?: Float32Array, ease?: (t: number) => number) => Float32Array;
/** Bake a multi-stop gradient into an array of pre-formatted CSS oklch() strings. */
export declare const bakeCssGradient: (colors: OklchColor[], steps: number, ease?: (t: number) => number) => string[];

/**
 * True iff an OKLCH color is displayable in sRGB without clipping. Tests the raw
 * linear-light R/G/B against [0,1]; alpha is ignored; the boundary is in-gamut.
 * Zero allocation. For tiered srgb/p3/out classification, see @zakkster/lite-hueforge.
 */
export declare const isInSrgb: (color: Pick<OklchColor, 'l' | 'c' | 'h'>) => boolean;
/**
 * Pull an out-of-gamut OKLCH color into sRGB by reducing chroma only, preserving
 * hue and lightness (L is clamped into [0,1] first). Fixed-iteration chroma
 * bisection; an in-gamut color is copied through unchanged. Alpha passes through.
 * Pass `out` for zero-allocation reuse.
 */
export declare const clampToSrgb: (color: OklchColor, out?: OklchColor) => Required<OklchColor>;
