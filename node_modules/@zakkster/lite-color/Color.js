/**
 * @zakkster/lite-color -- OKLCH color interpolation for games and gradients
 *
 * v1.1.0 adds LUT baking (bakeGradient / bakeCssGradient) and zero-GC RGB bridges
 * (toRgbTo / toRgbBytesTo) for WebGL buffers and canvas ImageData.
 *
 * v2.0.0 threads alpha end to end and completes the CSS Color 4 oklch() grammar.
 * BREAKING: bakeGradient's packed LUT is now 4 floats per stop (l, c, h, a),
 * up from 3. See decisions/0002-alpha-and-grammar.md and the CHANGELOG.
 *
 * v2.1.0 adds sRGB gamut lite: isInSrgb (does this clip?) and clampToSrgb
 * (reduce chroma to fit, preserving hue and lightness). Additive, non-breaking.
 * See decisions/0003-gamut-lite.md.
 *
 * Zero runtime dependencies. The three interpolation primitives below are
 * vendored byte-identical from @zakkster/lite-lerp, which remains the source of
 * truth if they ever diverge. See decisions/0001-inline-lerp-primitives.md for
 * why the former peer import was inlined (v1.1.1).
 */

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
const lerp = (a, b, t) => (t === 1 ? b : a + t * (b - a));
const wrap = (v, min, max) => {
    const range = max - min;
    return !(range > 0) ? min : min + (((v - min) % range) + range) % range;
};
const lerpAngle = (a, b, t) => a + wrap(b - a, -180, 180) * t;

/**
 * Linearly interpolates between two OKLCH colors.
 * Safely clamps Lightness (0-1) and prevents negative Chroma.
 * Alpha is interpolated linearly and clamped to [0,1]; a missing `a` on either
 * input is treated as 1 (fully opaque) per CSS Color 4.
 * NOTE: Allocates a new object. For hot-path use, prefer lerpOklchTo().
 *
 * @param {{ l: number, c: number, h: number, a?: number }} a - Start color
 * @param {{ l: number, c: number, h: number, a?: number }} b - End color
 * @param {number} t - Interpolation factor (0-1)
 * @returns {{ l: number, c: number, h: number, a: number }} New object
 */
export const lerpOklch = (a, b, t) => ({
    l: clamp(lerp(a.l, b.l, t), 0, 1),
    c: Math.max(0, lerp(a.c, b.c, t)),
    h: lerpAngle(a.h, b.h, t),
    a: clamp(lerp(a.a ?? 1, b.a ?? 1, t), 0, 1),
});

/**
 * Zero-GC variant of lerpOklch. Writes directly into a caller-owned output object.
 * Use this in render loops, LUT generation, or any per-frame hot path.
 *
 * @param {{ l: number, c: number, h: number, a?: number }} a - Start color
 * @param {{ l: number, c: number, h: number, a?: number }} b - End color
 * @param {number} t - Interpolation factor (0-1)
 * @param {{ l: number, c: number, h: number, a?: number }} out - Pre-allocated output
 * @returns {{ l: number, c: number, h: number, a: number }} Same `out` reference
 */
export const lerpOklchTo = (a, b, t, out) => {
    out.l = clamp(lerp(a.l, b.l, t), 0, 1);
    out.c = Math.max(0, lerp(a.c, b.c, t));
    out.h = lerpAngle(a.h, b.h, t);
    out.a = clamp(lerp(a.a ?? 1, b.a ?? 1, t), 0, 1);
    return out;
};

/**
 * Formats an OKLCH object into a browser-safe CSS string.
 * Uses fixed precision to prevent scientific notation bugs.
 *
 * @param {{ l: number, c: number, h: number, a?: number }} color
 */
export const toCssOklch = ({ l, c, h, a = 1 }) =>
    `oklch(${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(2)} / ${a})`;

// CSS Color 4 oklch() grammar. Reference ranges, per spec:
//   L: <number> | <0-100%>  -> 0-1
//   C: <number> | <0-100%>  -> 0-0.4   (NOTE: 100% chroma is 0.4, NOT 1)
//   H: <angle> (deg | rad | grad | turn) | unitless <number>, in degrees
//   A: <number> | <0-100%>  -> 0-1;  omitted -> 1;  explicit `none` -> 0
// `none` on any channel parses to 0. This is a deliberate simplification: the
// full CSS "powerless component" carry-forward during interpolation is out of
// scope for a game/render library. Malformed input throws (fail at config time,
// not while rendering an invisible gradient every frame).
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const OKLCH_RE = new RegExp(
    '^\\s*oklch\\(\\s*' +
    '(none|' + NUM + '%?)\\s+' +                     // L
    '(none|' + NUM + '%?)\\s+' +                     // C
    '(none|' + NUM + '(?:deg|rad|grad|turn)?)' +     // H (angle or unitless)
    '(?:\\s*/\\s*(none|' + NUM + '%?))?' +           // optional / A
    '\\s*\\)\\s*$',
    'i'
);

/** Parse an L/C/A channel token. `pctScale` maps 100% -> its channel maximum. */
const parseChannel = (tok, pctScale) =>
    tok.toLowerCase() === 'none'
        ? 0
        : tok.endsWith('%')
            ? (parseFloat(tok) / 100) * pctScale
            : parseFloat(tok);

/** Parse a hue token to degrees, honouring deg/rad/grad/turn (grad before rad). */
const parseHue = (tok) => {
    const t = tok.toLowerCase();
    if (t === 'none') return 0;
    const v = parseFloat(t);
    if (t.endsWith('turn')) return v * 360;
    if (t.endsWith('grad')) return v * 0.9;
    if (t.endsWith('rad')) return v * (180 / Math.PI);
    return v; // deg or unitless
};

/**
 * Parse a CSS Color 4 oklch() string back to an object. Full grammar:
 * numbers, percentages (L/C/A), `none` channels, deg/rad/grad/turn hue, the
 * `/ alpha` slash form (number or percentage), leading-dot numbers, and
 * flexible whitespace. Omitted alpha defaults to 1; explicit `none` alpha is 0.
 *
 * Throws on malformed input rather than returning null -- a typo fails when the
 * color is defined, not silently every frame it is rendered.
 *
 * @param {string} str - CSS oklch() string
 * @returns {{ l: number, c: number, h: number, a: number }}
 */
export const parseOklch = (str) => {
    const m = OKLCH_RE.exec(str);
    if (!m) throw new Error(`lite-color: cannot parse "${str}"`);
    return {
        l: parseChannel(m[1], 1),
        c: parseChannel(m[2], 0.4),
        h: parseHue(m[3]),
        a: m[4] === undefined ? 1 : parseChannel(m[4], 1),
    };
};

/**
 * Multi-stop gradient evaluation with optional easing.
 *
 * @param {Array} colors - Array of OKLCH color objects
 * @param {number} t - Progress (0-1)
 * @param {Function} [ease] - Optional easing function
 */
export const multiStopGradient = (colors, t, ease = (x) => x) => {
    if (!Array.isArray(colors) || colors.length === 0) {
        throw new Error("lite-color: colors array must contain at least 1 color");
    }
    if (colors.length === 1) return colors[0];

    const clampedT = clamp(ease(t), 0, 1);
    const scaledT = clampedT * (colors.length - 1);
    const index = Math.floor(scaledT);

    if (index >= colors.length - 1) return colors[colors.length - 1];

    const localT = scaledT - index;
    return lerpOklch(colors[index], colors[index + 1], localT);
};

/**
 * Zero-GC variant of multiStopGradient.
 * Writes directly into a caller-owned output object.
 *
 * @param {Array} colors - Array of OKLCH color objects
 * @param {number} t - Progress (0-1)
 * @param {{ l: number, c: number, h: number }} out - Pre-allocated output
 * @param {Function} [ease] - Optional easing function
 */
export const multiStopGradientTo = (colors, t, out, ease = (x) => x) => {
    if (!Array.isArray(colors) || colors.length === 0) {
        throw new Error("lite-color: colors array must contain at least 1 color");
    }
    if (colors.length === 1) {
        out.l = colors[0].l; out.c = colors[0].c; out.h = colors[0].h;
        out.a = colors[0].a ?? 1;
        return out;
    }

    const clampedT = clamp(ease(t), 0, 1);
    const scaledT = clampedT * (colors.length - 1);
    const index = Math.floor(scaledT);

    if (index >= colors.length - 1) {
        const last = colors[colors.length - 1];
        out.l = last.l; out.c = last.c; out.h = last.h;
        out.a = last.a ?? 1;
        return out;
    }

    const localT = scaledT - index;
    return lerpOklchTo(colors[index], colors[index + 1], localT, out);
};

/**
 * Creates a reusable gradient sampler function.
 *
 * @example
 * const heatmap = createGradient([cold, warm, hot], easeInOut);
 * const color = heatmap(0.5);
 */
export const createGradient = (colors, ease = (x) => x) => {
    if (!Array.isArray(colors) || colors.length === 0) {
        throw new Error("lite-color: colors array must contain at least 1 color");
    }
    return (t) => multiStopGradient(colors, t, ease);
};

/** Reverses a color array without mutating the original. */
export const reverseGradient = (colors) => [...colors].reverse();

/**
 * Picks a random color from anywhere along the gradient.
 * @param {Array} colors - The gradient array
 * @param {{ next: function(): number }} rng - An RNG with .next() returning [0, 1)
 */
export const randomFromGradient = (colors, rng) => {
    return multiStopGradient(colors, rng.next());
};

// === v1.1.0 -- LUT baking + RGB byte bridges ===

const DEG2RAD = Math.PI / 180;

/** sRGB electro-optical transfer. Negative inputs take the linear branch (no NaN). */
const srgbTransfer = (x) =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * (x ** (1 / 2.4)) - 0.055;

// Module-level scratch for linear-light sRGB (r, g, b). Single-threaded and
// non-reentrant: written then read within one synchronous call, never nested.
const _lin = [0, 0, 0];

/**
 * Internal: OKLCH -> linear-light sRGB. Writes r, g, b into out3[0..2].
 * No transfer function and no clamping -- the raw linear values a gamut test
 * needs. The sRGB bridges apply the transfer and clip on top of this.
 */
const oklchToLinear = (l, c, h, out3) => {
    const hr = h * DEG2RAD;
    const a_ = c * Math.cos(hr);
    const b_ = c * Math.sin(hr);

    let l_ = l + 0.3963377774 * a_ + 0.2158037573 * b_;
    let m_ = l - 0.1055613458 * a_ - 0.0638541728 * b_;
    let s_ = l - 0.0894841775 * a_ - 1.2914855480 * b_;

    l_ = l_ * l_ * l_;
    m_ = m_ * m_ * m_;
    s_ = s_ * s_ * s_;

    out3[0] = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
    out3[1] = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
    out3[2] = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_;
    return out3;
};

/**
 * Internal: OKLCH -> sRGB, written in place as RGBA at `out[offset]`.
 * Out-of-gamut colors are clipped (the safe, expected behavior for canvas/WebGL).
 */
const oklchToRgbInPlace = (l, c, h, a, out, offset, toBytes) => {
    oklchToLinear(l, c, h, _lin);

    const r = srgbTransfer(_lin[0]);
    const g = srgbTransfer(_lin[1]);
    const b = srgbTransfer(_lin[2]);

    if (toBytes) {
        out[offset]     = Math.round(clamp(r, 0, 1) * 255);
        out[offset + 1] = Math.round(clamp(g, 0, 1) * 255);
        out[offset + 2] = Math.round(clamp(b, 0, 1) * 255);
        out[offset + 3] = Math.round(clamp(a, 0, 1) * 255);
    } else {
        out[offset]     = clamp(r, 0, 1);
        out[offset + 1] = clamp(g, 0, 1);
        out[offset + 2] = clamp(b, 0, 1);
        out[offset + 3] = clamp(a, 0, 1);
    }
    return out;
};

/**
 * Zero-GC OKLCH -> normalized sRGB RGBA (0-1). Writes into a caller-owned `out` at `offset`.
 * The bridge to lite-gl RGBA instance fields, WebGL attribute buffers, and Float32Array.
 *
 * @param {{ l: number, c: number, h: number, a?: number }} color
 * @param {Float32Array|number[]} out - Caller-owned buffer, >= offset + 4 slots
 * @param {number} [offset=0]
 * @returns {Float32Array|number[]} Same `out` reference
 */
export const toRgbTo = (color, out, offset = 0) =>
    oklchToRgbInPlace(color.l, color.c, color.h, color.a ?? 1, out, offset, false);

/**
 * Zero-GC OKLCH -> sRGB bytes (0-255). Writes into a caller-owned `out` at `offset`.
 * The bridge to canvas ImageData (Uint8ClampedArray) and Uint8Array texture uploads.
 *
 * @param {{ l: number, c: number, h: number, a?: number }} color
 * @param {Uint8Array|Uint8ClampedArray|number[]} out - Caller-owned buffer, >= offset + 4 slots
 * @param {number} [offset=0]
 * @returns {Uint8Array|Uint8ClampedArray|number[]} Same `out` reference
 */
export const toRgbBytesTo = (color, out, offset = 0) =>
    oklchToRgbInPlace(color.l, color.c, color.h, color.a ?? 1, out, offset, true);

// === v2.1.0 -- sRGB gamut lite ===
//
// Scope: the <1KB, zero-dep, sRGB-only hot-path pair. isInSrgb answers "does
// this clip?"; clampToSrgb pulls a color back in by chroma alone. Tiered
// classification (srgb/p3/out), palette audits, and Display-P3 live in
// @zakkster/lite-hueforge (gamutOf / auditGamut) -- same algorithm shape,
// deliberately not a dependency (that would invert the micro-core arrow).

// Boundary tolerance in linear-light space. Absorbs float noise from the OKLab
// matrix so a color sitting exactly on a primary edge reads as in-gamut instead
// of flickering out on the last ulp. Tie-break: on the boundary is IN gamut.
const GAMUT_EPS = 1e-7;

// Fixed chroma-bisection budget for clampToSrgb. Chroma spans ~0-0.4, so 18
// halvings resolve the gamut boundary to 0.4 / 2^18 ~= 1.5e-6 -- far below any
// visible step, and bounded: no while-on-a-float in a predictable-cost core.
const CLAMP_ITERS = 18;

/** True iff the current _lin triple sits inside the unit cube within GAMUT_EPS. */
const linInGamut = () =>
    _lin[0] >= -GAMUT_EPS && _lin[0] <= 1 + GAMUT_EPS &&
    _lin[1] >= -GAMUT_EPS && _lin[1] <= 1 + GAMUT_EPS &&
    _lin[2] >= -GAMUT_EPS && _lin[2] <= 1 + GAMUT_EPS;

/**
 * Is an OKLCH color displayable in sRGB without clipping?
 *
 * Tests the raw linear-light R/G/B against [0,1]. The sRGB transfer is monotonic
 * on that range, so linear membership is exact and skips the transfer entirely.
 * Alpha is ignored (gamut is an RGB property). The boundary counts as in-gamut.
 * Zero allocation.
 *
 * @param {{ l: number, c: number, h: number }} color
 * @returns {boolean}
 */
export const isInSrgb = (color) => {
    oklchToLinear(color.l, color.c, color.h, _lin);
    return linInGamut();
};

/**
 * Pull an out-of-gamut OKLCH color into sRGB by reducing chroma only, preserving
 * hue and lightness. Fixed-iteration binary search on C (see CLAMP_ITERS); an
 * already-in-gamut color is copied through unchanged. Alpha passes through.
 *
 * Lightness is clamped into [0,1] first: no chroma can rescue an out-of-range L,
 * and returning a still-clipping color would break this function's contract that
 * its output is displayable. For any well-formed color (lerpOklch already clamps
 * L) that clamp is a no-op. See decisions/0003-gamut-lite.md.
 *
 * @param {{ l: number, c: number, h: number, a?: number }} color
 * @param {{ l: number, c: number, h: number, a?: number }} [out] - Pre-allocated output
 * @returns {{ l: number, c: number, h: number, a: number }} Same `out` reference
 */
export const clampToSrgb = (color, out = { l: 0, c: 0, h: 0, a: 1 }) => {
    const l = clamp(color.l, 0, 1);
    const h = color.h;
    const a = color.a ?? 1;

    oklchToLinear(l, color.c, h, _lin);
    if (linInGamut()) {
        out.l = l; out.c = color.c; out.h = h; out.a = a;
        return out;
    }

    // C = 0 is a gray of lightness l, always in gamut for l in [0,1] -- a valid
    // lower bound. Bisect the boundary between that and the requested chroma.
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < CLAMP_ITERS; i++) {
        const mid = (lo + hi) * 0.5;
        oklchToLinear(l, mid, h, _lin);
        if (linInGamut()) lo = mid; else hi = mid;
    }

    out.l = l; out.c = lo; out.h = h; out.a = a;
    return out;
};

/** Internal: validate a bake request and return an integer step count. */
const bakeSteps = (colors, steps) => {
    if (!Array.isArray(colors) || colors.length === 0) {
        throw new Error("lite-color: colors array must contain at least 1 color");
    }
    if (typeof steps !== "number" || !Number.isFinite(steps) || steps < 1) {
        throw new Error(`lite-color: steps must be a finite number >= 1, got ${steps}`);
    }
    return steps | 0;
};

/** Floats per stop in a bakeGradient LUT: l, c, h, a. */
export const BAKE_STRIDE = 4;

/**
 * Bake a multi-stop gradient into a packed Float32Array LUT of pre-evaluated OKLCH stops.
 * Each stop is 4 consecutive floats: [l0, c0, h0, a0, l1, c1, h1, a1, ...].
 *
 * BREAKING in v2.0.0: the stride grew from 3 to 4 floats per stop to carry alpha
 * (see BAKE_STRIDE). Index a stop's channels as base = i * BAKE_STRIDE.
 *
 * Setup-time by design. Sample it per frame with an index -- no lerp, no allocations.
 * Pass a reusable `out` (length >= steps * BAKE_STRIDE) to re-bake with zero allocations.
 *
 * @param {Array} colors - Array of OKLCH color objects
 * @param {number} steps - LUT resolution (truncated to an integer)
 * @param {Float32Array} [out] - Optional caller-owned buffer
 * @param {Function} [ease] - Optional easing function, applied as in multiStopGradient
 * @returns {Float32Array} `out` if provided, else a new Float32Array(steps * BAKE_STRIDE)
 */
export const bakeGradient = (colors, steps, out, ease = (x) => x) => {
    const n = bakeSteps(colors, steps);
    const len = n * BAKE_STRIDE;

    if (out === undefined || out === null) {
        out = new Float32Array(len);
    } else if (out.length < len) {
        throw new Error(`lite-color: out must have length >= ${len}, got ${out.length}`);
    }

    const temp = { l: 0, c: 0, h: 0, a: 1 };
    const denom = n > 1 ? n - 1 : 1;
    for (let i = 0; i < n; i++) {
        multiStopGradientTo(colors, i / denom, temp, ease);
        const idx = i * BAKE_STRIDE;
        out[idx] = temp.l;
        out[idx + 1] = temp.c;
        out[idx + 2] = temp.h;
        out[idx + 3] = temp.a;
    }
    return out;
};

/**
 * Bake a multi-stop gradient into an array of pre-formatted CSS oklch() strings.
 * Promotes the lite-confetti v1.1.0 lesson to a first-class API: format the palette
 * once at setup, then index it per frame. Never call toCssOklch() in a render loop.
 *
 * @param {Array} colors - Array of OKLCH color objects
 * @param {number} steps - LUT resolution (truncated to an integer)
 * @param {Function} [ease] - Optional easing function, applied as in multiStopGradient
 * @returns {string[]} Array of `steps` CSS oklch() strings
 */
export const bakeCssGradient = (colors, steps, ease = (x) => x) => {
    const n = bakeSteps(colors, steps);
    const result = new Array(n);

    const temp = { l: 0, c: 0, h: 0, a: 1 };
    const denom = n > 1 ? n - 1 : 1;
    for (let i = 0; i < n; i++) {
        multiStopGradientTo(colors, i / denom, temp, ease);
        result[i] = toCssOklch(temp);
    }
    return result;
};
