// @zakkster/lite-gc-profiler/register
//
// Node preload. Import with:
//   node --import @zakkster/lite-gc-profiler/register <script>
//
// Auto-starts a GcProfiler at module load, hooks 'beforeExit' to settle and
// write the target's summary as JSON to a temp path specified via
// LITE_GC_GATE_REPORT_PATH. The CLI reads that file after the child exits.
//
// The target script does not need to know about the profiler. This is the
// zero-touch integration path for gating any existing node script.
//
// If LITE_GC_GATE_REPORT_PATH is not set, the preload runs a profiler but
// does not persist output -- safe to use during development to see if the
// preload path resolves, without having to pipe reports anywhere.

import { GcProfiler } from './Gc.js';
import { writeFileSync } from 'node:fs';

const gc = new GcProfiler().start();
const outPath = process.env.LITE_GC_GATE_REPORT_PATH;

// beforeExit is the right hook: it fires when the loop is about to drain but
// still allows async work. process.on('exit') is synchronous and cannot await
// settle. If the target calls process.exit() explicitly, beforeExit is skipped
// -- v1.3.0 catches that case via a sync exit handler that writes a *partial*
// report the CLI downgrades to inconclusive instead of infrastructure error.
let hookRan = false;
process.on('beforeExit', () => {
    if (hookRan) return;
    hookRan = true;
    gc.settle().then(() => {
        const summary = gc.summary({ _capturedBy: 'lite-gc-gate/register' });
        gc.stop();
        if (outPath) {
            try {
                writeFileSync(outPath, JSON.stringify(summary));
            } catch (e) {
                // Never fail the target on report-write error; just report to stderr.
                process.stderr.write('lite-gc-gate: failed to write report to ' + outPath + ': ' + e.message + '\n');
            }
        }
    });
});

// G16.5: fallback handler for process.exit() bypass. Sync-only (exit hook
// cannot await), so no settle() -- we grab whatever state the profiler has.
// Skips silently if beforeExit already wrote a full report. Emits schema
// 'lite-gc-partial/1' so the CLI can distinguish complete vs partial and
// downgrade exit code appropriately.
process.on('exit', (code) => {
    if (hookRan) return;                                    // beforeExit handled it
    if (!outPath) return;                                   // no report path -> nothing to write
    try {
        gc.stop();
        const partialSummary = gc.summary({ _capturedBy: 'lite-gc-gate/register-exit' });
        const partial = {
            schema: 'lite-gc-partial/1',
            complete: false,
            reason: 'process_exit',
            exitCode: code,
            partialSummary,
            capturedAt: new Date().toISOString()
        };
        writeFileSync(outPath, JSON.stringify(partial));
    } catch (e) {
        process.stderr.write('lite-gc-gate: failed to write partial report on exit: ' + e.message + '\n');
    }
});

// Also expose the profiler on a well-known global so target scripts can call
// gc.phase('warmup') / gc.phase('steady') without importing the module. Kept
// as a Symbol-keyed property to avoid collisions with target code.
const REGISTRY_KEY = Symbol.for('@zakkster/lite-gc-profiler/register');
globalThis[REGISTRY_KEY] = gc;

export { gc };
