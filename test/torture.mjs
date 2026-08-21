/**
 * @zakkster/lite-rain -- torture gate.
 *
 *     node --expose-gc test/torture.mjs     -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Tiers share one shape (ROADMAP section 3). R1 wires the tiers correctness needs
 * now -- T1 (degenerate), T3 (the R-01/R-02 leak net), T4 (constructor/config
 * abuse), T6 (zero-alloc), T7 (soak + conservation), T9 (controls). T0/T5/T8 are
 * registered as empty tiers later sessions fill.
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * Controls: RAIN_TORTURE_BREAK=1 injects retained allocations into T6's hot loop
 * and must exit non-zero. A gate that cannot fail is decorative.
 *
 * Peers (lite-gc-profiler, lite-leak) are devDependencies only. RainEngine.js has
 * one runtime dependency (lite-color) and a zero-allocation hot path.
 *
 * @license MIT
 */

import { SEED, BREAK, metrics } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t3 } from './torture/t3-adversarial.mjs';
import { run as t4 } from './torture/t4-handles.mjs';
import { run as t5 } from './torture/t5-fuzz.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t8 } from './torture/t8-determinism.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T3 adversarial', t3],
    ['T4 handles', t4],
    ['T5 fuzz', t5],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T8 determinism', t8],
    ['T9 controls', t9],
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            await run();
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: RAIN_TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means T6's control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write('torture: FAIL -- RAIN_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    // Diagnostic GATE line (stderr; stdout stays exactly "ok").
    process.stderr.write(
        'GATE leak=size ' + metrics.leakSize + '/0 findings=' + metrics.leakFindings +
        ' warnings=' + metrics.leakWarnings +
        ' | gc major=' + metrics.gcMajor + ' minor=' + metrics.gcMinor +
        ' maxMs=' + metrics.gcMaxMs.toFixed(2) +
        ' | alloc=' + metrics.allocBytesPerOp + ' B/op\n');

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
