/**
 * @zakkster/lite-leak sink: profiler-signal
 *
 * Reactive boundary for leak telemetry: lifts leak-event counters into
 * lite-signal signals that can be bound to any HUD, dashboard, or effect
 * without pulling the tracker into the reactive graph itself.
 *
 * Design mirrors @zakkster/lite-profiler-signal's discipline: the sink
 * creates a fixed number of signals at construction (never more), and
 * writes to them from event callbacks. Users who want to throttle
 * downstream can wrap with `@zakkster/lite-throttle`; this sink does not
 * build throttling in, following the ecosystem's compose-don't-configure
 * principle.
 *
 * Ghost-safe: at construction, this creates ~6 signals total (leakCount,
 * warningCount, findingCount, errorCount, lastLeakKind, lastWarningKind).
 * That's a one-shot cost; no signal churn per event.
 */

import { signal, batch } from '@zakkster/lite-signal';

/**
 * Create a profiler-signal sink. Returns an object exposing:
 *   - `.onLeak` / `.onWarning` / `.onFinding` / `.onError` -- wire into tracker options
 *   - `.leakCount` / `.warningCount` / `.findingCount` / `.errorCount` -- reactive counters
 *   - `.lastLeakKind` / `.lastWarningKind` -- last-seen kinds
 *   - `.reset()` -- zero counters and last-kind signals
 *   - `.dispose()` -- release all signals (idempotent)
 */
export function createProfilerSignalSink() {
  const leakCount = signal(0);
  const warningCount = signal(0);
  const findingCount = signal(0);
  const errorCount = signal(0);
  const lastLeakKind = signal(null);
  const lastWarningKind = signal(null);

  let leaks = 0;
  let warnings = 0;
  let findings = 0;
  let errors = 0;
  let disposed = false;

  function safeKind(x) {
    if (x !== null && typeof x === 'object' && typeof x.kind === 'string') return x.kind;
    return 'unknown';
  }

  return {
    onLeak: function (report) {
      if (disposed) return;
      leaks++;
      const k = safeKind(report);
      batch(function () {
        leakCount.set(leaks);
        lastLeakKind.set(k);
      });
    },
    onWarning: function (finding) {
      if (disposed) return;
      warnings++;
      const k = safeKind(finding);
      batch(function () {
        warningCount.set(warnings);
        lastWarningKind.set(k);
      });
    },
    onFinding: function (finding) {
      if (disposed) return;
      findings++;
      findingCount.set(findings);
    },
    onError: function (_err, _tag) {
      if (disposed) return;
      errors++;
      errorCount.set(errors);
    },

    // Reactive readouts
    leakCount: leakCount,
    warningCount: warningCount,
    findingCount: findingCount,
    errorCount: errorCount,
    lastLeakKind: lastLeakKind,
    lastWarningKind: lastWarningKind,

    reset: function () {
      leaks = 0;
      warnings = 0;
      findings = 0;
      errors = 0;
      batch(function () {
        leakCount.set(0);
        warningCount.set(0);
        findingCount.set(0);
        errorCount.set(0);
        lastLeakKind.set(null);
        lastWarningKind.set(null);
      });
    },

    dispose: function () {
      if (disposed) return;
      disposed = true;
      // Signals from lite-signal do not require explicit disposal; the
      // engine reclaims them when no owner retains subscribers. Setting
      // `disposed` prevents further writes.
    },

    get _disposed() { return disposed; },
  };
}

/**
 * @zakkster/lite-leak sink: studio (DOM companion overlay)
 *
 * Mounts a fixed-position DOM overlay in the style of @zakkster/lite-studio:
 * dark theme, monospace, always-on-top. Renders a rolling log of leak
 * events, warnings, findings, and errors, capped at `maxLogRows`. Meant
 * to be mounted alongside lite-studio's main panel during a dev session.
 *
 * The overlay uses no signals internally (ghost contract): all state lives
 * in plain JS variables and DOM updates are imperative. No dependency on
 * lite-studio itself -- just visual affinity.
 */
export function createStudioSink(options) {
  const opts = options || {};
  const doMount = opts.mount !== false;
  const title = typeof opts.title === 'string' ? opts.title : 'lite-leak';
  const maxRows = typeof opts.maxLogRows === 'number' && opts.maxLogRows > 0 ? opts.maxLogRows : 60;
  const zIndex = typeof opts.zIndex === 'number' ? opts.zIndex : 2147482999;

  let root = null;
  let logEl = null;
  let countEls = null; // {leaks, warnings, findings, errors}
  let counts = { leaks: 0, warnings: 0, findings: 0, errors: 0 };
  let disposed = false;

  function mount() {
    if (typeof globalThis.document === 'undefined') return;
    if (root !== null) return; // already mounted

    const doc = globalThis.document;
    // Inject a scoped style tag once.
    if (doc.getElementById('lite-leak-studio-style') === null) {
      const style = doc.createElement('style');
      style.id = 'lite-leak-studio-style';
      style.textContent = [
        '.lite-leak-studio {',
        '  position: fixed; right: 12px; bottom: 12px;',
        '  min-width: 260px; max-width: 480px; max-height: 320px;',
        '  z-index: ' + zIndex + ';',
        '  background: #1e2327; color: #d0d4d8;',
        '  font: 11px/1.4 ui-monospace, "SF Mono", Menlo, monospace;',
        '  border: 1px solid #2f3237; border-radius: 4px;',
        '  overflow: hidden; display: flex; flex-direction: column;',
        '}',
        '.lite-leak-studio .hdr {',
        '  padding: 6px 8px; background: #12151a; color: #7db8ff;',
        '  border-bottom: 1px solid #2f3237; display: flex; gap: 8px;',
        '}',
        '.lite-leak-studio .hdr .title { flex: 1; font-weight: 600; }',
        '.lite-leak-studio .counters { display: flex; gap: 4px; padding: 4px 8px; }',
        '.lite-leak-studio .counters span { padding: 1px 5px; border-radius: 2px; }',
        '.lite-leak-studio .c-leak    { background: #6b2a2a; color: #ffd9d9; }',
        '.lite-leak-studio .c-warning { background: #6b5a2a; color: #fff2b8; }',
        '.lite-leak-studio .c-finding { background: #2a4a6b; color: #b8d9ff; }',
        '.lite-leak-studio .c-error   { background: #55273a; color: #ffb4d0; }',
        '.lite-leak-studio .log {',
        '  flex: 1; overflow-y: auto; padding: 4px 8px;',
        '  border-top: 1px solid #2f3237; white-space: pre-wrap;',
        '}',
        '.lite-leak-studio .row { padding: 1px 0; }',
        '.lite-leak-studio .row.leak    { color: #ff9a9a; }',
        '.lite-leak-studio .row.warning { color: #ffe58a; }',
        '.lite-leak-studio .row.finding { color: #8ac4ff; }',
        '.lite-leak-studio .row.error   { color: #ff9ac4; }',
        '.lite-leak-studio .row .k { opacity: 0.6; margin-right: 4px; }',
      ].join('');
      doc.head.appendChild(style);
    }

    root = doc.createElement('div');
    root.className = 'lite-leak-studio';
    root.innerHTML =
      '<div class="hdr"><span class="title"></span></div>' +
      '<div class="counters">' +
        '<span class="c-leak">L 0</span>' +
        '<span class="c-warning">W 0</span>' +
        '<span class="c-finding">F 0</span>' +
        '<span class="c-error">E 0</span>' +
      '</div>' +
      '<div class="log"></div>';
    root.querySelector('.title').textContent = title;
    logEl = root.querySelector('.log');
    const counterSpans = root.querySelectorAll('.counters span');
    countEls = {
      leaks: counterSpans[0],
      warnings: counterSpans[1],
      findings: counterSpans[2],
      errors: counterSpans[3],
    };
    doc.body.appendChild(root);
  }

  function pushRow(cls, kind, extra) {
    if (logEl === null) return;
    const doc = globalThis.document;
    const row = doc.createElement('div');
    row.className = 'row ' + cls;
    const k = doc.createElement('span');
    k.className = 'k';
    k.textContent = cls[0].toUpperCase();
    row.appendChild(k);
    row.appendChild(doc.createTextNode(kind + (extra ? ' ' + extra : '')));
    logEl.appendChild(row);
    // Cap log length.
    while (logEl.childNodes.length > maxRows) {
      logEl.removeChild(logEl.firstChild);
    }
    // Auto-scroll to bottom.
    logEl.scrollTop = logEl.scrollHeight;
  }

  function bumpCounter(name) {
    counts[name]++;
    if (countEls !== null) {
      const label = name === 'leaks' ? 'L' : name === 'warnings' ? 'W' : name === 'findings' ? 'F' : 'E';
      countEls[name].textContent = label + ' ' + counts[name];
    }
  }

  function safeKind(x) {
    if (x !== null && typeof x === 'object' && typeof x.kind === 'string') return x.kind;
    return 'unknown';
  }

  if (doMount) mount();

  return {
    onLeak: function (report) {
      if (disposed) return;
      bumpCounter('leaks');
      pushRow('leak', safeKind(report));
    },
    onWarning: function (finding) {
      if (disposed) return;
      bumpCounter('warnings');
      pushRow('warning', safeKind(finding));
    },
    onFinding: function (finding) {
      if (disposed) return;
      bumpCounter('findings');
      pushRow('finding', safeKind(finding));
    },
    onError: function (err, _tag) {
      if (disposed) return;
      bumpCounter('errors');
      const msg = err !== null && typeof err === 'object' && typeof err.message === 'string'
        ? err.message
        : String(err);
      pushRow('error', msg);
    },

    /** Mount the overlay lazily if `mount: false` was passed at construction. */
    mount: function () { if (!disposed) mount(); },

    /** Unmount the overlay (idempotent). */
    unmount: function () {
      if (disposed) return;
      if (root !== null && root.parentNode !== null) {
        root.parentNode.removeChild(root);
      }
      root = null;
      logEl = null;
      countEls = null;
    },

    /** Full teardown -- unmounts and permanently disables. Idempotent. */
    dispose: function () {
      if (disposed) return;
      this.unmount();
      disposed = true;
    },

    /** Test-only introspection. */
    _counts: function () { return { leaks: counts.leaks, warnings: counts.warnings, findings: counts.findings, errors: counts.errors }; },
    _rowCount: function () { return logEl !== null ? logEl.childNodes.length : 0; },
    _isMounted: function () { return root !== null; },
  };
}
