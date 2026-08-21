/**
 * @zakkster/lite-leak ecosystem sinks (M2.5)
 *
 * Adapters that route lite-leak events into other packages in the
 * @zakkster/lite-* ecosystem. Sinks are consumed by the tracker's option
 * callbacks (`onLeak`, `onWarning`, `onFinding`, `onError`).
 *
 * Design principle: sinks are plain factory functions that return objects
 * with `onLeak`, `onWarning`, `onFinding`, `onError` methods. The caller
 * wires each into the tracker at construction:
 *
 *   const sink = createTraceSink({ tracer });
 *   const tracker = createLeakTracker({
 *     onLeak:    sink.onLeak,
 *     onWarning: sink.onWarning,
 *     onFinding: sink.onFinding,
 *     onError:   sink.onError,
 *   });
 *
 * This shape composes: multiple sinks can be combined via createGenericSink
 * with a fanout callback that dispatches to each.
 */

/**
 * Trace sink -- emits @zakkster/lite-trace spans for leak events.
 *
 * The tracer's begin/end API is zero-alloc in steady state; each leak
 * event becomes a zero-duration span (begin immediately followed by end)
 * tagged with the event kind. When lite-trace's Chrome-trace JSON is
 * exported, these show up as instant markers on the timeline.
 *
 * @param {object} options
 * @param {object} options.tracer -- an instance of @zakkster/lite-trace's Tracer
 * @param {string} [options.leakTagPrefix='lite-leak/leak']
 * @param {string} [options.warningTagPrefix='lite-leak/warning']
 * @param {string} [options.findingTagPrefix='lite-leak/finding']
 * @param {string} [options.errorTag='lite-leak/error']
 * @returns {{
 *   onLeak: (report) => void,
 *   onWarning: (finding) => void,
 *   onFinding: (finding) => void,
 *   onError: (err, tag) => void,
 * }}
 */
export function createTraceSink(options) {
  if (options === null || options === undefined || options.tracer === undefined) {
    throw new TypeError('createTraceSink: options.tracer is required');
  }
  const tracer = options.tracer;
  const leakPrefix = typeof options.leakTagPrefix === 'string' ? options.leakTagPrefix : 'lite-leak/leak';
  const warnPrefix = typeof options.warningTagPrefix === 'string' ? options.warningTagPrefix : 'lite-leak/warning';
  const findPrefix = typeof options.findingTagPrefix === 'string' ? options.findingTagPrefix : 'lite-leak/finding';
  const errorTag = typeof options.errorTag === 'string' ? options.errorTag : 'lite-leak/error';

  function markInstant(tag) {
    // Zero-duration span: begin immediately followed by end. Matches
    // Perfetto's "instant" event semantic via Chrome-trace Complete events
    // with dur=0.
    if (typeof tracer.begin !== 'function' || typeof tracer.end !== 'function') return;
    tracer.begin(tag);
    tracer.end();
  }

  return {
    onLeak: function (report) {
      const kind = report !== null && typeof report === 'object' && typeof report.kind === 'string'
        ? report.kind
        : 'unknown';
      markInstant(leakPrefix + '/' + kind);
    },
    onWarning: function (finding) {
      const kind = finding !== null && typeof finding === 'object' && typeof finding.kind === 'string'
        ? finding.kind
        : 'unknown';
      markInstant(warnPrefix + '/' + kind);
    },
    onFinding: function (finding) {
      const kind = finding !== null && typeof finding === 'object' && typeof finding.kind === 'string'
        ? finding.kind
        : 'unknown';
      markInstant(findPrefix + '/' + kind);
    },
    onError: function (_err, _tag) {
      markInstant(errorTag);
    },
  };
}

/**
 * Generic sink -- composes multiple sinks or provides a hook for arbitrary
 * destinations (lite-signal-profiler, lite-devtools, lite-studio panels,
 * user-owned observability pipelines).
 *
 * Pass any callback in `options` to receive that channel's events. Missing
 * callbacks are no-ops. Multiple generic sinks can be composed by
 * constructing several and using each's output methods.
 *
 * Example -- combine trace sink and a custom studio panel adapter:
 *
 *   const trace = createTraceSink({ tracer });
 *   const studio = createGenericSink({
 *     onLeak:    (r) => studioPanel.pushLeak(r),
 *     onWarning: (w) => studioPanel.pushWarning(w),
 *   });
 *   const tracker = createLeakTracker({
 *     onLeak:    (r) => { trace.onLeak(r); studio.onLeak(r); },
 *     onWarning: (w) => { trace.onWarning(w); studio.onWarning(w); },
 *     onFinding: (f) => trace.onFinding(f),
 *     onError:   (e, t) => trace.onError(e, t),
 *   });
 *
 * @param {object} options
 * @param {(report) => void} [options.onLeak]
 * @param {(finding) => void} [options.onWarning]
 * @param {(finding) => void} [options.onFinding]
 * @param {(err, tag) => void} [options.onError]
 */
export function createGenericSink(options) {
  const opts = options || {};
  const onLeakCb = typeof opts.onLeak === 'function' ? opts.onLeak : null;
  const onWarningCb = typeof opts.onWarning === 'function' ? opts.onWarning : null;
  const onFindingCb = typeof opts.onFinding === 'function' ? opts.onFinding : null;
  const onErrorCb = typeof opts.onError === 'function' ? opts.onError : null;

  return {
    onLeak: function (report) {
      if (onLeakCb !== null) {
        try { onLeakCb(report); } catch (_e) { /* swallowed */ }
      }
    },
    onWarning: function (finding) {
      if (onWarningCb !== null) {
        try { onWarningCb(finding); } catch (_e) { /* swallowed */ }
      }
    },
    onFinding: function (finding) {
      if (onFindingCb !== null) {
        try { onFindingCb(finding); } catch (_e) { /* swallowed */ }
      }
    },
    onError: function (err, tag) {
      if (onErrorCb !== null) {
        try { onErrorCb(err, tag); } catch (_e) { /* swallowed */ }
      }
    },
  };
}
