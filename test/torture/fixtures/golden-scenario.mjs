/**
 * Shared constants + helpers for the v1.2.0 OFF-path byte-golden. Imported by BOTH
 * the generator (which runs the 1.2.0 engine) and T8 (which runs the R3 engine), so
 * the two runs are byte-for-byte the SAME scenario by construction.
 *
 * @license MIT
 */

/** The commit the golden engine source is extracted from (tagged "1.2.0"). */
export const SOURCE_COMMIT = '9aaa783';

/** Fixed PRNG seed -- independent of RAIN_TORTURE_SEED so the golden is stable. */
export const GOLDEN_SEED = 0x1234abcd;

/** The fixed scenario. Any change here invalidates the fixture -- regenerate. */
export const GOLDEN = Object.freeze({
    max: 600,
    w: 800, h: 600, dt: 0.016,
    frames: 400,
    density: 20, gravity: 1500, wind: 300, color: '#fff',
});

/** Base64 of a typed array's RAW bytes -- the unit of byte-identity. */
export function b64(arr) {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}
