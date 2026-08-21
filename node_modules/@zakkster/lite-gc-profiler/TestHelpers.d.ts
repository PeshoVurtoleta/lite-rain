import type { TestContext } from 'node:test';
import type { GcProfiler, GcRules, GcGateResult, AssertNoGcOptions } from './Gc.js';

export interface WithGcGateOptions extends AssertNoGcOptions {
    /** Duration-ring capacity, forwarded to the profiler. Default 256. */
    capacity?: number;
}

/**
 * Wrap a node:test body in start/settle/assert. On failure, emits the
 * formatted report to t.diagnostic() before rethrowing.
 *
 *   test('zero-alloc', async (t) => {
 *     await withGcGate(t, { maxMajor: 0 }, async (gc) => {
 *       runWork();
 *     });
 *   });
 */
export function withGcGate(
    t: TestContext,
    rules: GcRules,
    fn: (gc: GcProfiler) => Promise<void> | void,
    options?: WithGcGateOptions
): Promise<GcGateResult>;

/** Overload: rules omitted, defaults used. */
export function withGcGate(
    t: TestContext,
    fn: (gc: GcProfiler) => Promise<void> | void,
    _unused?: undefined,
    options?: WithGcGateOptions
): Promise<GcGateResult>;

export interface MeasureGcOptions {
    rules?: GcRules;
    capacity?: number;
}

/**
 * Quieter form: returns the report instead of asserting. Useful when the test
 * wants to inspect the verdict rather than fail.
 */
export function measureGc(
    t: TestContext,
    body: (gc: GcProfiler) => Promise<void> | void,
    options?: MeasureGcOptions
): Promise<GcGateResult>;
