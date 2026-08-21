export interface ExplainOptions {
    /** Bytes between samples. Default 512 KB. Smaller = more detail, more perturbation. */
    intervalBytes?: number;
    /** Number of top stacks to include. Default 10. */
    topN?: number;
}

export interface ExplainStack {
    selfSize: number;
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}

export interface ExplainResult {
    topStacks: ExplainStack[];
    samplingInterval: number;
    topN: number;
    error?: string;
}

export interface ExplainHandle {
    /** Resolves once the sampler is running. */
    started: Promise<void>;
    /**
     * Stop sampling and return top allocation stacks. Safe to call multiple
     * times; subsequent calls return { error: 'already stopped' }.
     */
    stop(): Promise<ExplainResult>;
}

/**
 * Start heap allocation sampling via node:inspector. Node-only.
 *
 * STRICT OPT-IN. Never active during a normal gated run -- the sampler
 * perturbs measurement. Use after a gate fails to identify allocator
 * stacks.
 */
export function startExplainSampling(options?: ExplainOptions): ExplainHandle;

/** Format an explain result as human-readable console output. */
export function formatExplainConsole(explainResult: ExplainResult): string;

// =============================================================================
// Batch 9 (v1.6.0) -- evidence lane (G21/G22).
// =============================================================================

/** Verdict from any gate report -- pass, fail, or inconclusive. */
export type GateVerdict = 'pass' | 'fail' | 'inconclusive';

/** Options for explainReport / explainDiff. */
export interface ExplainReportOptions {
    /** Emit ANSI colour codes for TTY-friendly output. Default false. */
    colour?: boolean;
    /**
     * Cap the number of violations listed in the body. The total count is
     * always shown in the header; overflow is announced with an
     * "... and N more" line. Default 10.
     */
    maxViolations?: number;
}

/**
 * Narrate a single gate report as a human-readable multi-line string.
 *
 * Accepts reports from every gate entry point: checkOps, checkFrames,
 * checkOpsAsync, assert* variants, and compareOps / compareFrames /
 * compareOpsAsync (which carry control + candidate blocks that are
 * rendered as a Comparison section).
 *
 * Reports without an explicit `schema` field are also accepted -- the
 * legacy sync-ops paths predate that tag. The verdict field is the only
 * requirement.
 */
export function explainReport(report: object, opts?: ExplainReportOptions): string;

/**
 * Narrate two INDEPENDENT gate reports as a diff. Convenience for the
 * case where the caller ran two separate check* calls (e.g. against
 * different baselines) and wants a compare-style narrative without
 * going through compare*.
 *
 * A kind mismatch (e.g. control='ops', candidate='frames') is surfaced
 * in the header, not thrown -- the caller may deliberately want a
 * cross-lane narrative for a report or slide.
 */
export function explainDiff(
    controlReport: object,
    candidateReport: object,
    opts?: ExplainReportOptions
): string;

/** Output format for gateBadge. */
export type GateBadgeFormat = 'text' | 'shields-json' | 'svg';

/** Options for gateBadge. */
export interface GateBadgeOptions {
    /** Format. Default 'text'. */
    format?: GateBadgeFormat;
    /** Left-hand label, e.g. 'gc gate' (default) or 'my-lib'. */
    label?: string;
}

/**
 * Produce a status badge for a gate report.
 *
 *   - 'text':          "gc gate: pass" / "gc gate: fail (2)" / "gc gate: inconclusive"
 *   - 'shields-json':  shields.io endpoint schema
 *                      { schemaVersion: 1, label, message, color }
 *   - 'svg':           self-contained shields-style SVG (~1 KB)
 *
 * Colours: brightgreen (pass), red (fail), yellow (inconclusive).
 */
export function gateBadge(report: object, opts?: GateBadgeOptions): string;
