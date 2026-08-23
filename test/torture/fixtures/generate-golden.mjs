/**
 * Regenerate the v1.2.0 OFF-path byte-golden fixture.
 *
 *     node test/torture/fixtures/generate-golden.mjs
 *
 * WHAT IT DOES. Extracts the ORIGINAL v1.2.0 engine from the committed history
 * (commit 9aaa783, tagged "1.2.0"), runs a FIXED seeded scenario over it, and
 * serializes the final SoA snapshot to `v1.2.0-off-golden.json` as base64 of each
 * buffer's raw bytes -- true, unambiguous byte-identity. T8 then asserts a current
 * R3 engine on its OFF path (defaults: gust:0, gustRate default, floorY:null,
 * splashDroplets:0, ripples:false) reproduces these exact bytes.
 *
 * The engine source is pulled from the FIXED commit `9aaa783`, not HEAD -- HEAD
 * moves once R3 commits, so this stays reproducible forever. The fixture is
 * committed; the test never shells out to git.
 *
 * FIXED SCENARIO (any change here invalidates the fixture -- regenerate):
 *   commit 9aaa783 : RainEngine.js
 *   seed    0x1234abcd (xorshift32 via makePrng, mapped to [0,1) by /2^32)
 *   max     600
 *   canvas  800 x 600, dt 0.016
 *   frames  400 (spawn + updateAndDraw every frame)
 *   config  { density: 20, gravity: 1500, wind: 300, color: '#fff', rng }
 *           -- base keys ONLY; the 1.2.0 engine knows no R3 keys.
 *
 * @license MIT
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePrng } from '../harness.mjs';
import { SOURCE_COMMIT, GOLDEN_SEED, GOLDEN, b64 } from './golden-scenario.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// The 1.2.0 engine imports the bare specifier '@zakkster/lite-color'; write it
// INSIDE the package so node resolves against the package's node_modules, then
// remove it. It is never committed.
const tmpEngine = join(here, '.v120-engine.mjs');

function ctxFake() {
    return {
        globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: '',
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, stroke() {}, fill() {},
        clearRect() {},
    };
}

async function main() {
    const src = execSync('git show ' + SOURCE_COMMIT + ':RainEngine.js', { encoding: 'utf8' });
    writeFileSync(tmpEngine, src);
    try {
        const mod = await import('./.v120-engine.mjs?ts=' + Date.now());
        const RainEngine = mod.RainEngine;
        const prng = makePrng(GOLDEN_SEED);
        const e = new RainEngine(GOLDEN.max, {
            density: GOLDEN.density, gravity: GOLDEN.gravity, wind: GOLDEN.wind,
            color: GOLDEN.color, rng: () => prng() / 4294967296,
        });
        const ctx = ctxFake();
        for (let f = 0; f < GOLDEN.frames; f++) {
            e.spawn(GOLDEN.dt, GOLDEN.w, GOLDEN.h);
            e.updateAndDraw(ctx, GOLDEN.dt, GOLDEN.w, GOLDEN.h);
        }
        const live = e.liveCount();
        if (!(live > 0 && live < e.max)) {
            throw new Error('vacuous golden -- liveCount ' + live + '/' + e.max);
        }
        const fixture = {
            meta: {
                sourceCommit: SOURCE_COMMIT,
                regen: 'node test/torture/fixtures/generate-golden.mjs',
                seed: GOLDEN_SEED, frames: GOLDEN.frames,
                w: GOLDEN.w, h: GOLDEN.h, dt: GOLDEN.dt, max: GOLDEN.max,
                config: { density: GOLDEN.density, gravity: GOLDEN.gravity, wind: GOLDEN.wind, color: GOLDEN.color },
                liveCount: live,
            },
            buffers: {
                x: b64(e.x), y: b64(e.y), vx: b64(e.vx), vy: b64(e.vy),
                state: b64(e.state), life: b64(e.life),
            },
        };
        writeFileSync(join(here, 'v1.2.0-off-golden.json'), JSON.stringify(fixture, null, 2) + '\n');
        process.stdout.write('golden written: liveCount=' + live + '/' + e.max + '\n');
    } finally {
        unlinkSync(tmpEngine);
    }
}

main();
