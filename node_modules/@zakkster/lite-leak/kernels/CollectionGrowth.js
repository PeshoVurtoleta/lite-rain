/**
 * @zakkster/lite-leak kernel: collection-growth
 *
 * Detects collections that only ever get bigger.
 *
 * Every other kernel here answers "was this resource released?". This one
 * covers the leak class where nothing is orphaned at all: a Map that is
 * correctly owned, correctly reachable, correctly cleaned up on disposal, and
 * simply never stops growing. A route cache keyed by URL, a memo table keyed by
 * object identity, a subscriber list appended to on every mount. Nothing is
 * leaked in the ownership sense, and the process still dies.
 *
 * Growth is a difference between moments, not a state, so this kernel cannot
 * work the way the others do. It records one sample per `audit()` call into a
 * fixed-size sliding window and reports when that window is entirely
 * non-decreasing and has grown by at least `minGrowth`.
 *
 * **A finding here is evidence, not proof, and the reason name says so.** A
 * cache filling during warmup is monotonic too. What separates it from a leak
 * is that it plateaus -- and because the window slides, a plateau clears the
 * finding on its own: once every sample in the window is equal, growth across
 * the window is zero and nothing is reported. That is the whole reason the
 * window slides rather than accumulating from process start. A detector that
 * measured from the first sample forever would flag every warmed cache in the
 * application and never stop.
 *
 * The window is a pre-allocated Float64Array shifted in place, so sampling
 * allocates nothing and the growth detector cannot itself grow without bound.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

const KIND = 'collection-growth';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));
const OPTION_KEYS = ['collections', 'window', 'minSamples', 'minGrowth', 'priority'];

/**
 * Current entry count of a collection, or -1 when it cannot be measured.
 * @private
 */
function measure(c) {
  if (c === null || typeof c !== 'object') return -1;
  if (typeof c.size === 'number') return c.size;          // Map, Set
  if (typeof c.length === 'number') return c.length;      // Array, TypedArray
  return -1;
}

/**
 * Create the collection-growth kernel.
 *
 * @param {object} options
 * @param {object} options.collections
 *   Name -> collection. Anything exposing a numeric `size` (Map, Set) or
 *   `length` (Array). Validated at construction: a collection that cannot be
 *   measured is rejected rather than silently watched and never reported.
 * @param {number} [options.window=8]
 *   Sliding window length in samples. Must be >= 2.
 * @param {number} [options.minSamples=4]
 *   Samples required before anything can be reported. Must be >= 2 and
 *   <= window.
 * @param {number} [options.minGrowth=1]
 *   Minimum increase across the window before it counts as growth.
 * @param {number} [options.priority=0]
 */
export function createCollectionGrowthKernel(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createCollectionGrowthKernel: options.collections is required');
  }
  const keys = Object.keys(options);
  for (let i = 0; i < keys.length; i++) {
    if (OPTION_KEYS.indexOf(keys[i]) === -1) {
      throw new TypeError(
        'createCollectionGrowthKernel: unknown option "' + keys[i] +
        '". Known options: ' + OPTION_KEYS.join(', ') + '.'
      );
    }
  }
  const opts = options || EMPTY_OPTIONS;
  const collections = opts.collections;
  if (collections === null || typeof collections !== 'object') {
    throw new TypeError(
      'createCollectionGrowthKernel: options.collections must be an object mapping ' +
      'name -> collection'
    );
  }
  const names = Object.keys(collections);
  if (names.length === 0) {
    throw new TypeError(
      'createCollectionGrowthKernel: options.collections is empty -- a kernel ' +
      'watching nothing would report clean forever'
    );
  }

  const window = opts.window === undefined ? 8 : opts.window;
  const minSamples = opts.minSamples === undefined ? 4 : opts.minSamples;
  const minGrowth = opts.minGrowth === undefined ? 1 : opts.minGrowth;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  for (const [label, value, floor] of [
    ['window', window, 2], ['minSamples', minSamples, 2], ['minGrowth', minGrowth, 0],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) {
      throw new TypeError(
        'createCollectionGrowthKernel: options.' + label +
        ' must be a finite number >= ' + floor + ' (got ' + String(value) + ')'
      );
    }
  }
  if (minSamples > window) {
    throw new TypeError(
      'createCollectionGrowthKernel: minSamples (' + minSamples +
      ') cannot exceed window (' + window + ') -- it could never be satisfied'
    );
  }

  const watched = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const c = collections[name];
    if (measure(c) < 0) {
      throw new TypeError(
        'createCollectionGrowthKernel: collection "' + name + '" exposes neither a ' +
        'numeric size nor length, so its growth could never be observed'
      );
    }
    watched.push({
      name: name,
      collection: c,
      samples: new Float64Array(window),   // shift-register, no per-sample alloc
      taken: 0,
    });
  }

  let ctx = null;

  /**
   * Record one sample and report on the window.
   * @private
   */
  function sampleAndCheck(w, findings) {
    const size = measure(w.collection);
    if (size < 0) return;   // collection swapped for something unmeasurable

    const buf = w.samples;
    for (let i = 0; i < window - 1; i++) buf[i] = buf[i + 1];
    buf[window - 1] = size;
    if (w.taken < window) w.taken++;

    if (w.taken < minSamples) return;   // not enough evidence yet; say nothing

    const start = window - w.taken;
    let nonDecreasing = true;
    for (let i = start + 1; i < window; i++) {
      if (buf[i] < buf[i - 1]) { nonDecreasing = false; break; }
    }
    if (!nonDecreasing) return;

    const growth = buf[window - 1] - buf[start];
    if (growth < minGrowth) return;   // plateaued: the window clears itself

    findings.push({
      kind: KIND,
      reason: 'monotonic-growth',
      collection: w.name,
      samples: w.taken,
      from: buf[start],
      to: buf[window - 1],
      growth: growth,
      origin: null,
    });
  }

  const kernel = {
    name: 'collection-growth',
    patchSurfaces: [],   // observes only; patches nothing
    priority: priority,

    install(kernelCtx) { ctx = kernelCtx; },

    uninstall() {
      ctx = null;
      for (let i = 0; i < watched.length; i++) {
        watched[i].samples.fill(0);
        watched[i].taken = 0;
      }
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      for (let i = 0; i < watched.length; i++) sampleAndCheck(watched[i], findings);
      return findings;
    },

    /**
     * Total entries across every watched collection. Read by snapshot(), so
     * two snapshots around an interaction show net collection growth exactly,
     * without the heuristic.
     */
    count: function () {
      let total = 0;
      for (let i = 0; i < watched.length; i++) {
        const n = measure(watched[i].collection);
        if (n < 0) return null;   // unmeasurable: null, never a partial total
        total += n;
      }
      return total;
    },

    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'monotonic-growth') {
        return 'Collection "' + finding.collection + '" grew across every sample ' +
               'in the window (' + finding.from + ' -> ' + finding.to + '). This is ' +
               'evidence, not proof: a cache filling during warmup is monotonic ' +
               'too, and the difference is that it plateaus. Re-check after the ' +
               'workload reaches steady state -- a plateau clears this finding on ' +
               'its own. If it keeps climbing, the collection needs a bound: an ' +
               'eviction policy, a max size, or WeakMap keys so entries die with ' +
               'the objects they describe.';
      }
      return null;
    },

    /** Samples taken so far, per collection. @private */
    _samplesTaken() {
      const out = Object.create(null);
      for (let i = 0; i < watched.length; i++) out[watched[i].name] = watched[i].taken;
      return out;
    },
  };

  return kernel;
}
