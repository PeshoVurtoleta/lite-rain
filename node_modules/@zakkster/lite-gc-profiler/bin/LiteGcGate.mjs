#!/usr/bin/env node
// @zakkster/lite-gc-profiler CLI: lite-gc-gate
//
// Usage:
//   lite-gc-gate run <script> [options]
//
// Options:
//   --reps N              Run the target N times and gate on the aggregate (default 1)
//   --config path         Load rules from JSON: { "rules": {...}, "policy": {...} }
//   --format fmt          console | json | markdown | github  (default: console)
//   --json path           Also write the JSON envelope to this path
//   --baseline path       Check against a baseline JSON file
//   --update-baseline     Write the current aggregate as a new baseline (to --baseline path)
//   --ratchet             Tighten the --baseline toward a passing run (element-wise min; only ever lowers). Requires --baseline; mutually exclusive with --update-baseline.
//   --accept-fingerprint-mismatch    Allow baseline comparison across fingerprints
//   --allow-inconclusive  Do not throw on inconclusive; exit 2 instead of 1
//
// Exit codes:
//   0 -- pass
//   1 -- fail (verdict=fail)
//   2 -- inconclusive (verdict=inconclusive)
//   3 -- infrastructure error (target crashed, config invalid, etc)

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checkNoGc, gateReps,
    createBaseline, checkAgainstBaseline, ratchetBaseline,
    aggregateGc,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations
} from '../Gc.js';

function usage(err) {
    if (err) process.stderr.write('lite-gc-gate: ' + err + '\n\n');
    process.stderr.write([
        'Usage: lite-gc-gate run <script> [options]',
        '',
        'Options:',
        '  --reps N              Run N times and aggregate',
        '  --config path         Load rules and policy from JSON',
        '  --format fmt          console | json | markdown | github',
        '  --json path           Also write JSON envelope to this path',
        '  --baseline path       Check against a baseline JSON file',
        '  --update-baseline     Write current aggregate as new baseline',
        '  --ratchet             Tighten --baseline toward a passing run (only ever lowers)',
        '  --accept-fingerprint-mismatch',
        '  --allow-inconclusive  Exit 2 instead of 1 on inconclusive',
        '',
        'Exit codes: 0=pass, 1=fail, 2=inconclusive, 3=infrastructure error'
    ].join('\n') + '\n');
    process.exit(3);
}

function parseArgs(argv) {
    const args = { reps: 1, format: 'console', flags: {} };
    if (argv[0] !== 'run') usage('first argument must be "run"');
    if (!argv[1]) usage('missing <script> path');
    args.script = argv[1];
    let i = 2;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--reps') { args.reps = parseInt(argv[++i], 10); if (!(args.reps > 0)) usage('--reps must be positive'); }
        else if (a === '--config') { args.configPath = argv[++i]; }
        else if (a === '--format') { args.format = argv[++i]; }
        else if (a === '--json') { args.jsonOutPath = argv[++i]; }
        else if (a === '--baseline') { args.baselinePath = argv[++i]; }
        else if (a === '--update-baseline') { args.flags.updateBaseline = true; }
        else if (a === '--ratchet') { args.flags.ratchet = true; }
        else if (a === '--accept-fingerprint-mismatch') { args.flags.acceptFingerprintMismatch = true; }
        else if (a === '--allow-inconclusive') { args.flags.allowInconclusive = true; }
        else usage('unknown arg: ' + a);
        i++;
    }
    // --ratchet needs a baseline to tighten, and contradicts a blind overwrite.
    if (args.flags.ratchet && !args.baselinePath) usage('--ratchet requires --baseline');
    if (args.flags.ratchet && args.flags.updateBaseline) {
        usage('--ratchet and --update-baseline are mutually exclusive: update overwrites '
            + 'the baseline in either direction, ratchet only tightens a passing run');
    }
    return args;
}

// Resolve register.mjs to an absolute path so --import= works regardless of
// CWD or how the CLI was invoked.
function resolveRegisterPath() {
    // bin/lite-gc-gate.mjs -> ../register.mjs
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), '..', 'Register.mjs');
}

function runOnce(scriptPath, tmpDir, repIdx) {
    const reportPath = join(tmpDir, 'report-' + repIdx + '.json');
    const registerPath = resolveRegisterPath();
    const res = spawnSync(process.execPath, [
        '--expose-gc',                                 // needed for the observer's precise GC entries in some setups
        '--import', 'data:text/javascript,import ' + JSON.stringify('file://' + registerPath),
        scriptPath
    ], {
        env: Object.assign({}, process.env, { LITE_GC_GATE_REPORT_PATH: reportPath }),
        stdio: ['ignore', 'inherit', 'inherit']
    });
    // v1.3.0 (G16.5): don't treat non-zero exit as fatal if a report exists.
    // If the target called process.exit(N), the sync exit handler in register
    // may have written a partial report; we prefer to gate on that partial
    // (with an inconclusive verdict) rather than surfacing an infrastructure
    // error the operator can't distinguish from a truly broken harness.
    if (!existsSync(reportPath)) {
        if (res.status !== 0) {
            return { error: 'target exited with status ' + res.status + ' and did not write a report' };
        }
        return { error: 'target did not write report (did it call process.exit()?)' };
    }
    let summary;
    try {
        summary = JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch (e) {
        return { error: 'could not parse report: ' + e.message };
    }
    // Partial report path: hard exit intercepted by register's exit hook.
    // Downgrade to inconclusive; downstream will emit exit code 2.
    if (summary && summary.schema === 'lite-gc-partial/1') {
        return {
            summary: summary.partialSummary,
            partial: {
                reason: summary.reason,
                exitCode: summary.exitCode,
                capturedAt: summary.capturedAt
            }
        };
    }
    return { summary };
}

function loadConfig(path) {
    if (!path) return { rules: undefined, policy: undefined };
    try {
        const cfg = JSON.parse(readFileSync(path, 'utf8'));
        return { rules: cfg.rules, policy: cfg.policy };
    } catch (e) {
        usage('failed to load config ' + path + ': ' + e.message);
    }
}

function emit(report, args) {
    let text;
    if (args.format === 'json') text = formatJson(report);
    else if (args.format === 'markdown') text = formatMarkdown(report);
    else if (args.format === 'github') text = formatGithubAnnotations(report);
    else text = formatConsole(report);
    process.stdout.write(text + '\n');
    if (args.jsonOutPath) {
        try { writeFileSync(args.jsonOutPath, formatJson(report)); }
        catch (e) { process.stderr.write('lite-gc-gate: --json write failed: ' + e.message + '\n'); }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const scriptPath = resolve(args.script);
    if (!existsSync(scriptPath)) usage('script not found: ' + scriptPath);

    const cfg = loadConfig(args.configPath);
    const rules = cfg.rules;
    const options = { policy: cfg.policy, allowInconclusive: args.flags.allowInconclusive };

    // Set up temp dir for report files
    const tmpDir = mkdtempSync(join(tmpdir(), 'lite-gc-gate-'));
    const summaries = [];
    let anyPartial = false;                                 // G16.5: any rep hit process.exit
    const partialInfo = [];
    try {
        for (let i = 0; i < args.reps; i++) {
            const r = runOnce(scriptPath, tmpDir, i);
            if (r.error) {
                process.stderr.write('lite-gc-gate: rep ' + i + ' failed: ' + r.error + '\n');
                process.exit(3);
            }
            summaries.push(r.summary);
            if (r.partial) {
                anyPartial = true;
                partialInfo.push({ rep: i, reason: r.partial.reason, exitCode: r.partial.exitCode });
            }
        }
    } finally {
        // Cleanup temp files
        for (let i = 0; i < summaries.length; i++) {
            const p = join(tmpDir, 'report-' + i + '.json');
            try { if (existsSync(p)) unlinkSync(p); } catch (_) { /* ignore */ }
        }
        try { rmdirSync(tmpDir); } catch (_) { /* ignore */ }
    }

    // Gate: single-rep uses checkNoGc; multi-rep uses gateReps.
    let report;
    if (args.baselinePath) {
        // Baseline path takes precedence over rule-based gate
        const agg = aggregateGc(summaries);
        if (args.flags.updateBaseline) {
            const baseline = createBaseline(agg);
            try {
                writeFileSync(args.baselinePath, JSON.stringify(baseline, null, 2));
                process.stdout.write('lite-gc-gate: baseline written to ' + args.baselinePath + '\n');
                process.exit(0);
            } catch (e) {
                process.stderr.write('lite-gc-gate: baseline write failed: ' + e.message + '\n');
                process.exit(3);
            }
        }
        let baseline;
        try { baseline = JSON.parse(readFileSync(args.baselinePath, 'utf8')); }
        catch (e) { process.stderr.write('lite-gc-gate: failed to load baseline: ' + e.message + '\n'); process.exit(3); }
        report = checkAgainstBaseline(agg, baseline, { acceptFingerprintMismatch: args.flags.acceptFingerprintMismatch });

        // G28: --ratchet tightens the committed baseline, but ONLY on a run
        // that passed. A fail or inconclusive leaves the file untouched -- you
        // never ratchet toward a number you just failed. The write happens
        // here (not in emit) so a write failure can surface as exit 3.
        if (args.flags.ratchet && report.verdict === 'pass') {
            const r = ratchetBaseline(baseline, agg, {
                acceptFingerprintMismatch: args.flags.acceptFingerprintMismatch
            });
            if (r.ratcheted) {
                try {
                    writeFileSync(args.baselinePath, JSON.stringify(r.baseline, null, 2));
                    process.stdout.write('lite-gc-gate: baseline ratcheted ('
                        + r.changed.length + ' metric' + (r.changed.length === 1 ? '' : 's')
                        + ' tightened: ' + r.changed.join(', ') + ')\n');
                } catch (e) {
                    process.stderr.write('lite-gc-gate: baseline ratchet write failed: ' + e.message + '\n');
                    process.exit(3);
                }
            } else {
                process.stdout.write('lite-gc-gate: baseline held (nothing tightened'
                    + (r.reason ? '; ' + r.reason : '') + ')\n');
            }
        }
    } else if (summaries.length > 1) {
        report = gateReps(summaries, rules, options);
    } else {
        report = checkNoGc(summaries[0], rules);
    }

    // G16.5: if any rep hit process.exit before beforeExit could settle, force
    // the final verdict to inconclusive. A hard exit means the measurement
    // window was truncated -- pass/fail on truncated data would be misleading.
    // Downgrading here (rather than exit-code-3'ing back in runOnce) lets the
    // operator SEE the partial-report data and diagnose, and CI still gets a
    // distinguishable exit code (2, not 3).
    if (anyPartial) {
        report = Object.assign({}, report, {
            verdict: 'inconclusive',
            reason: 'partial_report',
            partial: partialInfo
        });
    }

    emit(report, args);

    if (report.verdict === 'pass') process.exit(0);
    if (report.verdict === 'fail') process.exit(1);
    // inconclusive
    process.exit(args.flags.allowInconclusive ? 2 : 2);   // exit 2 either way for CI to differentiate
}

main();
