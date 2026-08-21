/**
 * @zakkster/lite-leak presets
 *
 * `createDefaultKernels()` composes the kernel set for whatever runtime you are
 * actually in, and tells you what it left out.
 *
 * It exists because assembling the set by hand has two traps, both of which
 * produce a detector that looks installed and is not:
 *
 *   1. `timer-orphan` claims `requestAnimationFrame` by default, so adding
 *      `raf-orphan` afterwards throws `KernelConflictError`. The fix is
 *      `createTimerOrphanKernel({ handleRaf: false })`, and the reason to want
 *      it is that raf-orphan models a render loop as a chain of continuations
 *      rather than as a fire-once timer -- the better detector loses to the
 *      weaker one if you compose them in the obvious order. This preset always
 *      cedes the rAF surface to raf-orphan.
 *
 *   2. A kernel whose globals are absent still registers. In Node, with no
 *      `MutationObserver` and no `Worker`, `observer-orphan` and
 *      `worker-orphan` install, claim their surfaces, patch nothing, and report
 *      clean forever. Nothing in the API distinguishes that from a genuinely
 *      quiet run. So this preset checks availability up front and returns the
 *      skipped kernels as data: `skipped` is meant to be logged or asserted on,
 *      not ignored.
 *
 * Two kernels are deliberately NOT included, because both need configuration
 * that cannot be guessed and a wrong guess would watch the wrong thing:
 *
 *   - `detached-dom` needs a root to observe (defaults to `document`, which is
 *     rarely the subtree you care about).
 *   - `gl-resource-orphan` needs a specific WebGL context; an application may
 *     hold several.
 *
 * Register those explicitly alongside the preset.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

import { createOwnerCascadeOrphanKernel } from './kernels/OwnerCascadeOrphan.js';
import { createTimerOrphanKernel } from './kernels/TimerOrphan.js';
import { createRafOrphanKernel } from './kernels/RafOrphan.js';
import { createListenerOrphanKernel } from './kernels/ListenerOrphan.js';
import { createObserverOrphanKernel } from './kernels/ObserverOrphan.js';
import { createAsyncRetentionKernel } from './kernels/AsyncRetention.js';
import { createWorkerOrphanKernel } from './kernels/WorkerOrphan.js';
import { createAudioNodeKernel } from './kernels/AudioNode.js';
import { createSocketOrphanKernel } from './kernels/SocketOrphan.js';

const DEFAULT_PRESET_KEYS = ['target', 'warnOnNoOwner', 'captureStacks', 'exclude'];

/** @private */
function isFn(v) { return typeof v === 'function'; }

/**
 * Availability probes and factories, in registration order. `needs` returns the
 * reason a kernel cannot work here, or null when it can.
 * @private
 */
const ENTRIES = [
  {
    name: 'owner-cascade-orphan',
    needs: function () { return null; },   // pure owner-tree walk, no globals
    make: function (o) { return createOwnerCascadeOrphanKernel(o.base()); },
  },
  {
    name: 'timer-orphan',
    needs: function (t) { return isFn(t.setTimeout) ? null : 'no setTimeout on target'; },
    // Always cede rAF to raf-orphan; see the note at the top of this file.
    make: function (o) { return createTimerOrphanKernel(o.base({ handleRaf: false })); },
  },
  {
    name: 'raf-orphan',
    needs: function (t) {
      return isFn(t.requestAnimationFrame) ? null : 'no requestAnimationFrame on target';
    },
    make: function (o) { return createRafOrphanKernel(o.base()); },
  },
  {
    name: 'listener-orphan',
    needs: function (t) {
      return isFn(t.EventTarget) ? null : 'no EventTarget on target';
    },
    make: function (o) { return createListenerOrphanKernel(o.base()); },
  },
  {
    name: 'observer-orphan',
    needs: function (t) {
      return (isFn(t.MutationObserver) || isFn(t.ResizeObserver) || isFn(t.IntersectionObserver))
        ? null : 'no MutationObserver / ResizeObserver / IntersectionObserver on target';
    },
    make: function (o) { return createObserverOrphanKernel(o.base()); },
  },
  {
    name: 'async-retention',
    needs: function (t) { return isFn(t.AbortController) ? null : 'no AbortController on target'; },
    make: function (o) { return createAsyncRetentionKernel(o.base()); },
  },
  {
    name: 'worker-orphan',
    needs: function (t) {
      return (isFn(t.Worker) || isFn(t.SharedWorker)) ? null : 'no Worker / SharedWorker on target';
    },
    make: function (o) { return createWorkerOrphanKernel(o.base()); },
  },
  {
    name: 'audio-node',
    needs: function (t) { return isFn(t.AudioNode) ? null : 'no AudioNode on target'; },
    make: function (o) { return createAudioNodeKernel(o.base()); },
  },
  {
    name: 'socket-orphan',
    needs: function (t) {
      return (isFn(t.WebSocket) || isFn(t.EventSource)) ? null : 'no WebSocket / EventSource on target';
    },
    make: function (o) { return createSocketOrphanKernel(o.base()); },
  },
];

/**
 * Build the kernel set appropriate to a runtime.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   Object the kernels patch. Pass a mock in tests.
 * @param {boolean} [options.warnOnNoOwner=true]
 *   Forwarded to every kernel that accepts it.
 * @param {boolean} [options.captureStacks=false]
 *   Forwarded to every kernel that accepts it. Costs an Error per tracked
 *   resource; leave off outside debugging.
 * @param {string[]} [options.exclude]
 *   Kernel names to leave out (they appear in `skipped` with reason
 *   'excluded by caller').
 * @returns {{ kernels: object[], skipped: Array<{ name: string, reason: string }> }}
 *   `kernels` in registration order, ready to pass to `registerKernel`.
 *   `skipped` is the honest half: log it or assert on it, because a kernel that
 *   is not here is one whose leaks nothing will report.
 */
export function createDefaultKernels(options) {
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object') {
      throw new TypeError('createDefaultKernels: options must be an object, got ' + typeof options);
    }
    const keys = Object.keys(options);
    for (let i = 0; i < keys.length; i++) {
      if (DEFAULT_PRESET_KEYS.indexOf(keys[i]) === -1) {
        throw new TypeError(
          'createDefaultKernels: unknown option "' + keys[i] + '". Known options: ' +
          DEFAULT_PRESET_KEYS.join(', ') + '.'
        );
      }
    }
  }
  const opts = options || {};
  const target = opts.target || globalThis;
  const exclude = Array.isArray(opts.exclude) ? opts.exclude : [];

  const shared = {
    base: function (extra) {
      const o = { target: target };
      if (opts.warnOnNoOwner !== undefined) o.warnOnNoOwner = opts.warnOnNoOwner;
      if (opts.captureStacks !== undefined) o.captureStacks = opts.captureStacks;
      if (extra !== undefined) {
        const ks = Object.keys(extra);
        for (let i = 0; i < ks.length; i++) o[ks[i]] = extra[ks[i]];
      }
      return o;
    },
  };

  const kernels = [];
  const skipped = [];

  for (let i = 0; i < ENTRIES.length; i++) {
    const entry = ENTRIES[i];
    if (exclude.indexOf(entry.name) !== -1) {
      skipped.push({ name: entry.name, reason: 'excluded by caller' });
      continue;
    }
    const reason = entry.needs(target);
    if (reason !== null) {
      skipped.push({ name: entry.name, reason: reason });
      continue;
    }
    kernels.push(entry.make(shared));
  }

  return { kernels: kernels, skipped: skipped };
}
