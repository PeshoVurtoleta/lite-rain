// Canonical zero-GC test. Copy verbatim to test/99-gc-gate.mjs in each
// package that opts into the Zero-GC badge. Adjust ONLY the import path of
// the package under test (line marked ADJUST) and the workload body (line
// marked WORKLOAD).
//
// Run:  node --expose-gc --test test/99-gc-gate.mjs
//
// This template is the promise the badge makes. If it passes, the package
// meets the zero-GC gate under a strict D4 all-clean policy for majors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGcGate } from '@zakkster/lite-gc-profiler/test-helpers';

// ADJUST: import the package under test (PascalCase filename convention)
import * as pkg from '../<PACKAGE_NAME>.js';

// WORKLOAD: replace with the hottest, most-representative operation your
// package exposes. Keep it short (~200ms), representative, and free of test
// scaffolding allocation. Structure as warmup then steady if the package has
// a one-time setup cost that should be excluded from the gate.
async function workload(gc) {
    gc.phase('warmup');
    // Warm any JIT/pool/cache. GC during warmup is allowed by phase rules.
    for (let i = 0; i < 100; i++) pkg.doWork(i);

    gc.phase('steady');
    // The claim: no major GC during steady-state work.
    for (let i = 0; i < 100000; i++) pkg.doWork(i);
}

test('zero-GC gate: no major collections during steady state', async (t) => {
    await withGcGate(t, {
        phases: {
            warmup: { maxMajor: 1 },              // one major allowed during warmup
            steady: { maxMajor: 0, maxMinor: 0 }  // strict: zero in steady
        }
    }, workload);
});
