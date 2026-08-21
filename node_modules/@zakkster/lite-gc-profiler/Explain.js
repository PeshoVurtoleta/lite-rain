// @zakkster/lite-gc-profiler/explain
//
// Explain mode: heap allocation profiling via node:inspector's
// HeapProfiler.startSampling. Node-only.
//
// STRICT OPT-IN. Never active during a normal gated run -- the sampler
// perturbs the very thing it measures. Explain mode is for AFTER a gate
// fails, when you want to know WHICH allocation stacks caused the pressure.
//
// The attribution disclaimer: this answers "who allocated," which is not the
// same as "where the pause fired." Region attribution (G10) is firing-site;
// explain mode is allocator-site. Both are useful; neither substitutes for
// the other.
//
// v1.6.0 -- evidence lane (G21/G22):
//   explainReport(report)              -- narrate a single gate report
//   explainDiff(control, candidate)    -- narrate two independent gate reports as a diff
//   gateBadge(report, opts)            -- SVG / shields-JSON / text badge for CI
//
// These are pure formatters. They read gate reports and emit strings.
// They do not measure, allocate hot-path buffers, or side-effect the
// profiler -- the whole point is that they can run in a failed CI job
// or a browser without contaminating the very thing that just failed.

/**
 * Format an explain report as human-readable console output.
 */
function formatExplainConsole(explainResult) {
    if (explainResult.error) {
        return 'Explain: error: ' + explainResult.error;
    }
    const lines = ['Top allocation stacks (interval=' + explainResult.samplingInterval + ' bytes):'];
    if (explainResult.topStacks.length === 0) {
        lines.push('  (no samples captured)');
        return lines.join('\n');
    }
    let maxNameLen = 0;
    for (const s of explainResult.topStacks) {
        if (s.functionName.length > maxNameLen) maxNameLen = s.functionName.length;
    }
    if (maxNameLen > 40) maxNameLen = 40;
    for (const s of explainResult.topStacks) {
        const bytes = s.selfSize;
        const kb = (bytes / 1024).toFixed(1);
        const name = s.functionName.length > 40 ? s.functionName.slice(0, 37) + '...' : s.functionName;
        const paddedName = name + ' '.repeat(Math.max(0, maxNameLen - name.length));
        const loc = s.url + ':' + s.lineNumber;
        lines.push('  ' + paddedName + '  ' + kb.padStart(8) + ' KB   ' + loc);
    }
    return lines.join('\n');
}

export { formatExplainConsole, explainReport, explainDiff, gateBadge };

// =============================================================================
// Batch 9 (v1.6.0) -- evidence lane (G21/G22).
//
// Purpose: close the loop between "gate failed in CI" and "developer sees why
// in the log." The gate reports have every fact a formatter needs -- verdict,
// violations with actual/limit/rule, checked map, source, kind, run parameters
// nested in .result or .control/.candidate -- but nothing in v1.5 makes them
// readable. explainReport / explainDiff produce that narrative; gateBadge
// produces a machine-consumable status marker (SVG, shields JSON, or plain
// text) for README/CI ornaments.
//
// Discipline: pure formatters. Read reports, emit strings. No measurement,
// no perturbation, no hot-path allocation concerns -- these run in a failed
// CI job where correctness of the readout matters more than nanoseconds.
// =============================================================================

// Rule -> short human name. Kept explicit so a typo in a rule name doesn't
// silently render as itself.
const _RULE_LABELS = {
    // Whole-window rules (pre-v1.3 lineage).
    maxMajor: 'major GCs',
    maxMinor: 'minor GCs',
    maxIncremental: 'incremental GCs',
    maxTotalMs: 'total GC time (ms)',
    maxMaxMs: 'max GC pause (ms)',
    maxBytes: 'total retained bytes',
    // Per-op rules.
    maxBytesPerOp: 'bytes per op',
    maxMajorsPerKOp: 'major GCs per 1000 ops',
    maxMinorsPerKOp: 'minor GCs per 1000 ops',
    maxPauseMsPerOp: 'max GC pause per op (ms)',
    // Per-frame rules.
    maxBytesPerFrame: 'bytes per frame',
    maxMajorsPerKFrame: 'major GCs per 1000 frames',
    maxMinorsPerKFrame: 'minor GCs per 1000 frames',
    maxPauseMsPerFrame: 'max GC pause per frame (ms)',
    maxDroppedFrames: 'dropped frames',
    // Delta rules.
    maxExtraBytesPerOp: 'extra bytes per op vs control',
    maxExtraMajorsPerKOp: 'extra major GCs per 1000 ops vs control',
    maxExtraMinorsPerKOp: 'extra minor GCs per 1000 ops vs control',
    maxExtraPauseMsPerOp: 'extra max GC pause per op vs control',
    maxExtraBytesPerFrame: 'extra bytes per frame vs control',
    maxExtraDroppedFrames: 'extra dropped frames vs control'
};

function _label(rule) {
    return _RULE_LABELS[rule] || rule;
}

function _fmtNum(v) {
    if (v === null || v === undefined) return '(null)';
    if (typeof v !== 'number') return String(v);
    if (!Number.isFinite(v)) return String(v);       // 'NaN', 'Infinity'
    // Integer path -- cheaper and reads cleaner than toFixed for whole counts.
    if (Number.isInteger(v)) return String(v);
    // Two decimals is enough for bytes/rates without noise; more is spurious
    // precision on a gate readout.
    return v.toFixed(2);
}

/**
 * Render a name that came from a report into a single safe log token.
 *
 * Rule and metric names are emitted verbatim into console output, markdown and
 * -- via formatGithubAnnotations -- into GitHub Actions workflow commands,
 * which are newline-delimited. A name containing a newline therefore FORGES a
 * second annotation: a metric called `bytesPerOp\n::error::INJECTED` was
 * measured producing two `::error` directives where one was intended, the
 * second entirely controlled by the report's contents. ANSI escapes passed
 * through to terminals the same way, and a 2 MB name produced 2 MB of log.
 *
 * Reports produced by this library only ever carry names from its own fixed
 * vocabulary, and I could not reach this through any public API -- the
 * baseline comparator ignores metric keys it does not recognise. It is
 * reachable only by formatting a report that was built by hand or
 * deserialized from somewhere else, which the formatters do accept. Cheap
 * defence, so: control characters out, length capped.
 */
function _safeName(value) {
    let str = typeof value === 'string' ? value : String(value);
    // eslint-disable-next-line no-control-regex
    str = str.replace(/[\u0000-\u001f\u007f]/g, ' ');
    if (str.length > 200) str = str.slice(0, 197) + '...';
    return str;
}

function _fmtDelta(actual, limit) {
    if (typeof actual !== 'number' || typeof limit !== 'number'
        || !Number.isFinite(actual) || !Number.isFinite(limit)) return '';
    const d = actual - limit;
    if (d === 0) return ' (at limit)';
    const sign = d > 0 ? '+' : '';
    if (limit === 0) return ' (delta ' + sign + _fmtNum(d) + ')';
    const pct = (d / Math.abs(limit)) * 100;
    // The ratio can overflow for extreme actuals (1e308 against a limit of 1
    // reported "+Infinity% over limit"). Show the delta and drop the ratio
    // rather than print a number that is not one.
    if (!Number.isFinite(pct)) return ' (delta ' + sign + _fmtNum(d) + ')';
    return ' (' + sign + _fmtNum(d) + '; ' + sign + _fmtNum(pct) + '% over limit)';
}

function _validateReport(fnName, report) {
    if (!report || typeof report !== 'object') {
        throw new TypeError(fnName + ': report must be a gate report object');
    }
    // Duck-type: a gate report is defined by having a pass/fail/inconclusive
    // verdict. schema='lite-gc-report/1' is present on newer paths (frames,
    // ops-async) but older sync-ops and reps-aware reports predate that tag
    // and only carry .kind. Accept both; reject anything that doesn't quack
    // like a report at all.
    if (report.verdict !== 'pass' && report.verdict !== 'fail' && report.verdict !== 'inconclusive') {
        throw new TypeError(fnName + ': report.verdict must be pass|fail|inconclusive; got '
            + JSON.stringify(report.verdict));
    }
    if (report.schema !== undefined && report.schema !== 'lite-gc-report/1') {
        throw new TypeError(fnName + ': report.schema, when set, must be "lite-gc-report/1"; got '
            + JSON.stringify(report.schema));
    }
}

// Extract run parameters from whatever measurement result the report carries.
// Reports carry either .result (single-gate) or .control+.candidate (compare).
// Both share the same measurement-result shape from the ops/frames/ops-async
// lanes -- we pull the parameters that identify what was measured.
function _runFooter(report) {
    const r = report.result || report.candidate || null;
    if (!r) return '';
    const lines = [];
    if (typeof r.ops === 'number') {
        lines.push('  ops:     ' + r.ops);
        if (typeof r.warmupOps === 'number') lines.push('  warmup:  ' + r.warmupOps);
    }
    if (typeof r.frames === 'number') {
        lines.push('  frames:  ' + r.frames);
        if (typeof r.warmupFrames === 'number') lines.push('  warmup:  ' + r.warmupFrames);
        if (typeof r.frameBudgetMs === 'number') lines.push('  budget:  ' + _fmtNum(r.frameBudgetMs) + ' ms');
    }
    if (typeof r.source === 'string') lines.push('  source:  ' + r.source);
    // Trustworthiness flags -- present on frames/async-ops results.
    if (r.bytesPerOpStable !== undefined) {
        lines.push('  stabilized: ' + (r.bytesPerOpStable ? 'yes' : 'no (raw two-point delta -- higher noise)'));
    }
    if (r.bytesPerFrameStable !== undefined) {
        lines.push('  stabilized: ' + (r.bytesPerFrameStable ? 'yes' : 'no (slope estimate -- floor around 1000 B/frame)'));
    }
    if (r.asyncResidual !== undefined && r.asyncResidual > 0) {
        lines.push('  async residual: ' + _fmtNum(r.asyncResidual)
            + ' bytes (fire-and-forget work outlived the measurement window)');
    }
    return lines.length ? '\nRun:\n' + lines.join('\n') : '';
}

// Rule-specific hints: pulled from the report, not invented. Hints only fire
// when there is concrete evidence for them in the report itself -- no
// speculative advice.
function _hints(report) {
    const r = report.result || report.candidate || null;
    if (!r) return [];
    const out = [];
    if (r.bytesPerFrameStable === false) {
        out.push('bytesPerFrame is the slope estimate here (stabilize was off or unavailable). '
            + 'Consider running under node --expose-gc for a stabilized live-set delta.');
    }
    if (r.bytesPerOpStable === false) {
        out.push('bytesPerOp is the raw two-point delta here (stabilize was off or unavailable). '
            + 'Cold-start noise can read multi-KB/op; run under node --expose-gc for a stabilized reading.');
    }
    if (r.asyncResidual !== undefined && r.asyncResidual > 0) {
        out.push('Non-zero async residual (' + _fmtNum(r.asyncResidual) + ' bytes) means the workload spawned '
            + 'fire-and-forget microtasks/timers that outlived the measurement window. '
            + 'Attribution across those boundaries is inexact; wrap the outbound work in an await if possible.');
    }
    if (report.reason === 'source_mismatch') {
        out.push('Control and candidate ran on different sources; deltas are not comparable. '
            + 'Re-run both with the same explicit source: option.');
    }
    return out;
}

/**
 * Narrate a single gate report as a human-readable multi-line string.
 * Accepts any report produced by check* / assert* or compare* / assertCompare*.
 *
 * @param {object} report                          Gate report (schema 'lite-gc-report/1').
 * @param {{ colour?: boolean, maxViolations?: number }} [opts]
 *   colour:        emit ANSI colour codes for TTY-friendly output. Default false.
 *   maxViolations: cap listed violations (they are all counted in the header).
 *                  Default 10.
 * @returns {string}
 */
function explainReport(report, opts) {
    _validateReport('explainReport', report);
    const options = opts || {};
    const colour = options.colour === true;
    const maxViolations = options.maxViolations > 0 ? (options.maxViolations | 0) : 10;

    const kind = report.kind || 'ops';                // legacy check reports default to ops
    const verdict = report.verdict;
    const violations = Array.isArray(report.violations) ? report.violations : [];

    // Header colouring: green pass, red fail, yellow inconclusive. Off by
    // default so pipes stay clean.
    const clr = (code, s) => colour ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s;
    const verdictTag = verdict === 'pass' ? clr('32', 'PASS')
                    : verdict === 'fail'  ? clr('31', 'FAIL')
                                          : clr('33', 'INCONCLUSIVE');

    const header = 'gc-gate: ' + verdictTag + ' -- ' + kind
        + (report.reason ? ' (' + report.reason + ')' : '');

    const parts = [header];

    if (verdict === 'fail' && violations.length > 0) {
        parts.push('');
        parts.push('Violations (' + violations.length + '):');
        const shown = violations.slice(0, maxViolations);
        for (const v of shown) {
            // Violation shape varies across the codebase:
            //   Newer (frames, ops-async):   { rule, metric, actual, limit }
            //   Legacy (ops, compare, reps): { metric, actual, limit, reason }
            // rule is a rule name (maxBytesPerOp); metric is a measurement path
            // (gc.major, bytesPerOp, gc.major.delta). Prefer rule for the header
            // but fall back to metric so legacy reports still render usefully.
            // A malformed entry must not take the narrator down: this runs
            // precisely when something has already gone wrong, and throwing
            // here replaces a useful failure report with a stack trace.
            if (v === null || typeof v !== 'object') {
                parts.push('  ' + clr('31', '(malformed violation entry: ' + _safeName(v) + ')'));
                continue;
            }
            const heading = v.rule || v.metric || '(unknown)';
            const metricLabel = v.rule && v.metric && v.rule !== v.metric
                ? ' [' + _safeName(v.metric) + ']' : '';
            parts.push('  ' + clr('31', _safeName(heading)) + metricLabel);
            parts.push('    actual: ' + _fmtNum(v.actual));
            parts.push('    limit:  ' + _fmtNum(v.limit) + _fmtDelta(v.actual, v.limit));
            // Prefer the explicit human-readable reason from legacy violations;
            // fall back to the label table indexed by rule/metric name.
            // v.reason is free text carried on the violation and lands in the
            // same log stream as everything else -- sanitize it too. It was the
            // one emitted field the first pass missed.
            const explanation = _safeName(v.reason || _label(heading));
            if (explanation && explanation !== heading) {
                parts.push('    means:  ' + explanation);
            }
        }
        if (violations.length > maxViolations) {
            parts.push('  ... and ' + (violations.length - maxViolations) + ' more (raise maxViolations to see all)');
        }
    } else if (verdict === 'inconclusive') {
        parts.push('');
        parts.push('Cannot verify:');
        // Rules in .checked with a falsy value are the unverifiable ones.
        const checked = report.checked || {};
        const unverified = Object.keys(checked).filter((k) => !checked[k]);
        if (unverified.length === 0) {
            parts.push('  (no specific rule flagged; report.reason=' + JSON.stringify(report.reason) + ')');
        } else {
            for (const rule of unverified) {
                // Do not assert a cause that has not been established. Since
                // v1.5.2 a rule also lands here when the METRIC was non-finite
                // -- a broken clock or heap source -- in which case the source
                // is fine and blaming it sends the reader the wrong way.
                parts.push('  ' + clr('33', _safeName(rule))
                    + ' -- not verified (source "' + _safeName(report.source || 'unknown')
                    + '" could not measure it, or the measurement was not finite)');
            }
        }
    } else if (verdict === 'pass') {
        const checked = report.checked || {};
        const verifiedCount = Object.keys(checked).filter((k) => checked[k]).length;
        if (verifiedCount > 0) {
            parts.push('  ' + verifiedCount + ' rule' + (verifiedCount === 1 ? '' : 's') + ' verified');
        }
    }

    // For compare reports: expose the control/candidate deltas the compare
    // computed -- readers want to see BOTH numbers, not just the delta.
    if (report.control && report.candidate) {
        parts.push('');
        parts.push('Comparison:');
        const c = report.control, k = report.candidate;
        if (c.bytesPerOp !== undefined || k.bytesPerOp !== undefined) {
            parts.push('  bytesPerOp:    control=' + _fmtNum(c.bytesPerOp)
                + '  candidate=' + _fmtNum(k.bytesPerOp));
        }
        if (c.bytesPerFrame !== undefined || k.bytesPerFrame !== undefined) {
            parts.push('  bytesPerFrame: control=' + _fmtNum(c.bytesPerFrame)
                + '  candidate=' + _fmtNum(k.bytesPerFrame));
        }
        if (c.droppedFrames !== undefined || k.droppedFrames !== undefined) {
            parts.push('  droppedFrames: control=' + _fmtNum(c.droppedFrames)
                + '  candidate=' + _fmtNum(k.droppedFrames));
        }
    }

    parts.push(_runFooter(report));

    const hints = _hints(report);
    if (hints.length > 0) {
        parts.push('');
        parts.push('Hints:');
        for (const h of hints) parts.push('  * ' + h);
    }

    return parts.filter((p) => p !== '' || parts.indexOf(p) < parts.length - 1).join('\n');
}

/**
 * Narrate two INDEPENDENT gate reports as a diff. Convenience for users who
 * ran two separate check* calls (e.g. against distinct baselines) and want
 * to see them side-by-side without going through the compare* entry point.
 *
 * If both reports have report.result (single-gate shape), the output frames
 * the two results and their per-rule metric deltas. Rules present in one
 * report but not the other are flagged.
 *
 * @param {object} controlReport
 * @param {object} candidateReport
 * @param {{ colour?: boolean }} [opts]
 * @returns {string}
 */
function explainDiff(controlReport, candidateReport, opts) {
    _validateReport('explainDiff (control)', controlReport);
    _validateReport('explainDiff (candidate)', candidateReport);
    const options = opts || {};
    const colour = options.colour === true;
    const clr = (code, s) => colour ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s;

    // Kind mismatch is not fatal (a user might want ops vs frames comparison
    // narrated for prose reasons) but is worth naming.
    const kMismatch = controlReport.kind !== candidateReport.kind
        ? ' (kind mismatch: control=' + controlReport.kind + ' candidate=' + candidateReport.kind + ')'
        : '';

    const parts = [
        'gc-gate: diff -- ' + (controlReport.kind || 'ops') + kMismatch,
        '',
        'Control:    ' + clr(controlReport.verdict === 'pass' ? '32' : controlReport.verdict === 'fail' ? '31' : '33',
            controlReport.verdict.toUpperCase()),
        'Candidate:  ' + clr(candidateReport.verdict === 'pass' ? '32' : candidateReport.verdict === 'fail' ? '31' : '33',
            candidateReport.verdict.toUpperCase())
    ];

    const cR = controlReport.result;
    const kR = candidateReport.result;
    if (cR && kR) {
        parts.push('');
        parts.push('Metrics:');
        const metrics = ['bytesPerOp', 'bytesPerFrame', 'droppedFrames',
                         'majorsPerKOp', 'minorsPerKOp', 'majorsPerKFrame',
                         'minorsPerKFrame', 'maxPauseMsPerOp', 'maxPauseMsPerFrame'];
        for (const m of metrics) {
            if (cR[m] === undefined && kR[m] === undefined) continue;
            const cv = cR[m], kv = kR[m];
            let delta = '';
            if (typeof cv === 'number' && typeof kv === 'number'
                && Number.isFinite(cv) && Number.isFinite(kv)) {
                const d = kv - cv;
                if (d !== 0) {
                    const sign = d > 0 ? '+' : '';
                    delta = '  (' + sign + _fmtNum(d) + ')';
                }
            }
            parts.push('  ' + m.padEnd(20) + ' control=' + _fmtNum(cv)
                + '  candidate=' + _fmtNum(kv) + delta);
        }
    }

    return parts.join('\n');
}

/**
 * Produce a status badge for a gate report. Formats:
 *
 *   'shields-json': shields.io endpoint schema (JSON)
 *                   -- { schemaVersion: 1, label, message, color }
 *   'svg':          self-contained SVG string (~1 KB), shields-style
 *   'text':         short one-line text like "gc: pass" or "gc: fail (2)"
 *
 * @param {object} report
 * @param {{ format?: 'shields-json'|'svg'|'text', label?: string }} [opts]
 * @returns {string}
 */
function gateBadge(report, opts) {
    _validateReport('gateBadge', report);
    const options = opts || {};
    const format = options.format || 'text';
    const label = options.label || 'gc gate';
    const verdict = report.verdict;

    // shields.io named colours.
    const color = verdict === 'pass' ? 'brightgreen'
                : verdict === 'fail' ? 'red'
                                     : 'yellow';
    let message = verdict;
    if (verdict === 'fail' && Array.isArray(report.violations) && report.violations.length > 0) {
        message = 'fail (' + report.violations.length + ')';
    }

    if (format === 'text') {
        return label + ': ' + message;
    }
    if (format === 'shields-json') {
        return JSON.stringify({
            schemaVersion: 1,
            label: label,
            message: message,
            color: color
        });
    }
    if (format === 'svg') {
        // Small self-contained shields-style SVG. Widths are approximate --
        // font-metric perfection would need a table of glyph widths; for a
        // status badge, the 6-per-char approximation is close enough that
        // GitHub renders it cleanly at README scale.
        const svgColor = verdict === 'pass' ? '#4c1'
                       : verdict === 'fail' ? '#e05d44'
                                            : '#dfb317';
        const labelW = 6 * label.length + 12;
        const messageW = 6 * message.length + 12;
        const totalW = labelW + messageW;
        return '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW + '" height="20" role="img" aria-label="' + label + ': ' + message + '">'
            + '<title>' + label + ': ' + message + '</title>'
            + '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>'
            + '<clipPath id="r"><rect width="' + totalW + '" height="20" rx="3" fill="#fff"/></clipPath>'
            + '<g clip-path="url(#r)">'
            + '<rect width="' + labelW + '" height="20" fill="#555"/>'
            + '<rect x="' + labelW + '" width="' + messageW + '" height="20" fill="' + svgColor + '"/>'
            + '<rect width="' + totalW + '" height="20" fill="url(#s)"/>'
            + '</g>'
            + '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">'
            + '<text x="' + (labelW / 2) + '" y="15" fill="#010101" fill-opacity=".3">' + label + '</text>'
            + '<text x="' + (labelW / 2) + '" y="14">' + label + '</text>'
            + '<text x="' + (labelW + messageW / 2) + '" y="15" fill="#010101" fill-opacity=".3">' + message + '</text>'
            + '<text x="' + (labelW + messageW / 2) + '" y="14">' + message + '</text>'
            + '</g></svg>';
    }
    throw new RangeError('gateBadge: opts.format must be "shields-json" | "svg" | "text"; got '
        + JSON.stringify(format));
}
