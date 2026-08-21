// @zakkster/lite-gc-profiler/test-helpers
//
// Node:test integration. Wraps a test body in start/settle/assert so callers
// write one call instead of five. Reports via the test context's diagnostic
// channel on failure, so the CI log shows the report next to the test name.

import { GcProfiler, checkNoGc, assertNoGc, formatConsole } from './Gc.js';

/**
 * Wrap a node:test body with GC gating. Starts a profiler, runs the body,
 * settles, asserts the summary against rules. On failure, emits the formatted
 * report to the test's diagnostic channel before rethrowing.
 *
 *   test('my zero-alloc claim', async (t) => {
 *     await withGcGate(t, { maxMajor: 0 }, async () => {
 *       runMyCode();
 *     });
 *   });
 *
 * With rules omitted, defaults to { maxMajor: 0 }.
 * With options.allowInconclusive, does not throw on inconclusive verdicts.
 *
 * @param {import('node:test').TestContext} t
 * @param {Object|Function} rulesOrFn  rules object, or the body if defaults are fine
 * @param {Function} [fn]              the test body when rules were given
 * @param {Object} [options]           { allowInconclusive?: boolean, capacity?: number }
 */
async function withGcGate(t, rulesOrFn, fn, options) {
    // Overload: withGcGate(t, fn) uses default rules
    let rules, body;
    if (typeof rulesOrFn === 'function') {
        rules = undefined;
        body = rulesOrFn;
    } else {
        rules = rulesOrFn;
        body = fn;
    }
    const opts = options || {};
    const capacity = opts.capacity && opts.capacity > 0 ? opts.capacity : 256;

    const gc = new GcProfiler(capacity).start();
    try {
        await body(gc);                              // pass the profiler in case the body wants phases
    } finally {
        // Always settle and stop, even on body throw, so we don't leak an
        // observer to the next test.
        try {
            await gc.settle();
        } catch (_e) { /* settle should never throw */ }
    }
    const summary = gc.summary();
    gc.stop();

    try {
        return assertNoGc(summary, rules, { allowInconclusive: opts.allowInconclusive });
    } catch (e) {
        // Attach the formatted report to the test's diagnostic output so the
        // failure message in CI shows what the gate saw.
        if (t && typeof t.diagnostic === 'function' && e.report) {
            const lines = formatConsole(e.report).split('\n');
            for (const line of lines) t.diagnostic(line);
        }
        throw e;
    }
}

/**
 * A quieter form of withGcGate that returns the report instead of throwing.
 * Use when you want to inspect the verdict rather than asserting it.
 */
async function measureGc(t, body, options) {
    const opts = options || {};
    const capacity = opts.capacity && opts.capacity > 0 ? opts.capacity : 256;
    const gc = new GcProfiler(capacity).start();
    try {
        await body(gc);
    } finally {
        try { await gc.settle(); } catch (_e) { /* ignore */ }
    }
    const summary = gc.summary();
    gc.stop();
    return checkNoGc(summary, opts.rules);
}

export { withGcGate, measureGc };
