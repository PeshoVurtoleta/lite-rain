/**
 * @zakkster/lite-leak kernel: timer-orphan
 *
 * Detects and prevents timer-related leaks:
 *   - setTimeout / setInterval / requestAnimationFrame set inside an
 *     effect/computed body: auto-wires clearTimeout on owner disposal so
 *     forgotten cleanup no longer leaks the callback's closure.
 *   - Timers set OUTSIDE any owner: emits `onWarning` at set-time -- the
 *     earliest possible signal that a timer has no attached lifecycle.
 *   - Currently-pending timers whose owner has been disposed via a broken
 *     cascade: surfaced via `audit()`.
 *
 * Design: patches the target global (default `globalThis`) or an override
 * (used by tests). Timer IDs are looked up in a per-kernel Map on clear
 * calls. Timer callbacks are tracked via lite-leak's own `track()` with
 * `{ audit: true }` so the FR-refine path can classify true post-owner
 * leaks as `'timer-orphan'`.
 *
 * Patch surfaces claimed: 'setTimeout', 'setInterval',
 * 'requestAnimationFrame'.
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'timer-orphan';
const T_TIMEOUT = 'setTimeout';
const T_INTERVAL = 'setInterval';
const T_RAF = 'requestAnimationFrame';

const EMPTY_OPTIONS = Object.freeze(Object.create(null));

/**
 * Create the timer-orphan kernel.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   The object whose timer methods are patched. Tests provide a mock
 *   clock / rAF harness here.
 * @param {boolean} [options.warnOnNoOwner=true]
 *   Emit `onWarning` when a timer is set outside any lite-signal owner.
 * @param {boolean} [options.captureStacks=false]
 *   Capture `Error().stack` at set-time and attach as `origin`.
 * @param {boolean} [options.handleRaf=true]
 *   When false, do NOT claim or patch requestAnimationFrame /
 *   cancelAnimationFrame, leaving that surface for the loop-aware
 *   `raf-orphan` kernel. Set this false whenever you install
 *   `createRafOrphanKernel()` alongside this kernel.
 * @param {number} [options.priority=0]
 *   Kernel priority for refine-chain / audit ordering.
 */
export function createTimerOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;
  // When false, this kernel does NOT claim or patch the requestAnimationFrame
  // surface, leaving it for the loop-aware `raf-orphan` kernel to own. Default
  // true preserves the historical one-shot rAF behaviour. See RafOrphan.js.
  const handleRaf = opts.handleRaf !== false;

  let ctx = null;
  // id -> { kind, cb, id, ownerHandle, handle, origin }
  const timers = new Map();
  // Snapshot of originals for uninstall. null when not installed.
  let originals = null;
  // The wrappers WE installed, so uninstall can tell our slot from someone else's.
  let ours = null;
  // Surfaces claimed globally (target-scoped), released on uninstall.
  let claimed = null;

  // Every surface this kernel may patch, in one list: claim, capture and
  // restore all walk it, so they cannot drift apart.
  const PATCHABLE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame'];

  function makeWrapper(state, isInterval) {
    return function timerWrapper() {
      if (ctx === null) {
        // Kernel uninstalled between schedule and fire; run cb, skip
        // bookkeeping.
        return state.cb.apply(this, arguments);
      }
      if (!isInterval) {
        timers.delete(state.id);
        ctx.untrack(state.handle);
      }
      return state.cb.apply(this, arguments);
    };
  }

  function scheduleGeneric(kind, cb, originalCall) {
    if (ctx === null) return originalCall(cb);
    const ownerHandle = getOwner();
    const origin = captureStacks ? new Error().stack : null;
    const state = {
      kind: kind,
      cb: cb,
      id: undefined,
      ownerHandle: ownerHandle,
      handle: null,
      origin: origin,
    };
    const wrapper = makeWrapper(state, kind === T_INTERVAL);
    const id = originalCall(wrapper);
    state.id = id;
    const handle = ctx.track(cb, function () {}, { kind: kind, id: id }, { audit: true });
    state.handle = handle;
    timers.set(id, state);
    if (ownerHandle !== undefined) {
      onCleanup(function () {
        if (originals === null) return;
        const s = timers.get(id);
        if (s === undefined) return;
        timers.delete(id);
        if (kind === T_TIMEOUT) originals.clearTimeout.call(target, id);
        else if (kind === T_INTERVAL) originals.clearInterval.call(target, id);
        else if (kind === T_RAF) originals.cancelAnimationFrame.call(target, id);
      });
    } else if (warnOnNoOwner) {
      ctx.emitWarning({
        kind: KIND,
        reason: 'no-owner-set',
        timerKind: kind,
        timerId: id,
        origin: origin,
      });
    }
    return id;
  }

  function makeCancel(kind) {
    return function cancel(id) {
      if (ctx !== null) {
        const state = timers.get(id);
        if (state !== undefined && state.kind === kind) {
          timers.delete(id);
          ctx.untrack(state.handle);
        }
      }
      if (originals === null) return;
      if (kind === T_TIMEOUT) return originals.clearTimeout.call(target, id);
      if (kind === T_INTERVAL) return originals.clearInterval.call(target, id);
      if (kind === T_RAF) return originals.cancelAnimationFrame.call(target, id);
    };
  }

  const kernel = {
    name: 'timer-orphan',
    patchSurfaces: handleRaf
      ? ['setTimeout', 'setInterval', 'requestAnimationFrame']
      : ['setTimeout', 'setInterval'],
    priority: priority,

    install(kernelCtx) {
      // Claim before patching: two kernel instances on the same target must not
      // both wrap it. Rolls back anything already claimed if a later one clashes.
      claimed = [];
      let contested = null;
      const surfaces = handleRaf ? PATCHABLE : PATCHABLE.slice(0, 4);
      for (const s of surfaces) {
        if (typeof target[s] !== 'function') continue;
        if (_claimPatchSurface(target, s)) claimed.push(s);
        else { if (contested === null) contested = []; contested.push(s); }
      }
      ours = Object.create(null);
      ctx = kernelCtx;
      if (contested !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: contested,
          detail: 'already patched by another lite-leak kernel instance; both are now ' +
            'active, so these surfaces will be double-counted',
        });
      }
      originals = {
        setTimeout: target.setTimeout,
        clearTimeout: target.clearTimeout,
        setInterval: target.setInterval,
        clearInterval: target.clearInterval,
        requestAnimationFrame: target.requestAnimationFrame,
        cancelAnimationFrame: target.cancelAnimationFrame,
      };

      if (typeof originals.setTimeout === 'function') {
        target.setTimeout = function patchedSetTimeout(cb, ms) {
          const argc = arguments.length;
          if (argc <= 2) {
            return scheduleGeneric(T_TIMEOUT, cb, function (wrapperOrCb) {
              return originals.setTimeout.call(target, wrapperOrCb, ms);
            });
          }
          const extra = new Array(argc - 2);
          for (let i = 0; i < argc - 2; i++) extra[i] = arguments[i + 2];
          return scheduleGeneric(T_TIMEOUT, cb, function (wrapperOrCb) {
            return originals.setTimeout.call(target, wrapperOrCb, ms, ...extra);
          });
        };
      }
      if (typeof originals.clearTimeout === 'function') {
        target.clearTimeout = makeCancel(T_TIMEOUT);
      }
      if (typeof originals.setInterval === 'function') {
        target.setInterval = function patchedSetInterval(cb, ms) {
          const argc = arguments.length;
          if (argc <= 2) {
            return scheduleGeneric(T_INTERVAL, cb, function (wrapperOrCb) {
              return originals.setInterval.call(target, wrapperOrCb, ms);
            });
          }
          const extra = new Array(argc - 2);
          for (let i = 0; i < argc - 2; i++) extra[i] = arguments[i + 2];
          return scheduleGeneric(T_INTERVAL, cb, function (wrapperOrCb) {
            return originals.setInterval.call(target, wrapperOrCb, ms, ...extra);
          });
        };
      }
      if (typeof originals.clearInterval === 'function') {
        target.clearInterval = makeCancel(T_INTERVAL);
      }
      if (handleRaf && typeof originals.requestAnimationFrame === 'function') {
        target.requestAnimationFrame = function patchedRaf(cb) {
          return scheduleGeneric(T_RAF, cb, function (wrapperOrCb) {
            return originals.requestAnimationFrame.call(target, wrapperOrCb);
          });
        };
      }
      if (handleRaf && typeof originals.cancelAnimationFrame === 'function') {
        target.cancelAnimationFrame = makeCancel(T_RAF);
      }
      // Record exactly what we installed, in one place, so uninstall can tell
      // our wrapper from one a third party layered on afterwards. Done as a
      // sweep rather than at each assignment so a future edit to any wrapper
      // cannot forget to register it.
      for (const prop of PATCHABLE) {
        if (typeof originals[prop] === 'function' && target[prop] !== originals[prop]) {
          ours[prop] = target[prop];
        }
      }
    },

    uninstall() {
      if (originals === null) return;
      // Restore only slots we still own. If a third party wrapped us after
      // install, a blind assignment would silently un-instrument them.
      let clobbered = null;
      for (const prop of PATCHABLE) {
        if (typeof originals[prop] !== 'function') continue;
        if (ours[prop] === undefined) continue;
        if (!_restoreIfOurs(target, prop, ours[prop], originals[prop])) {
          if (clobbered === null) clobbered = [];
          clobbered.push(prop);
        }
      }
      if (clobbered !== null && ctx !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-layered',
          surfaces: clobbered,
          detail: 'another wrapper was installed over these after this kernel; left in place',
        });
      }
      if (claimed !== null) { for (const s of claimed) _releasePatchSurface(target, s); claimed = null; }
      ours = null;
      // Keep `originals` alive when we deliberately left a wrapper installed.
      // Those orphaned wrappers still run (a third party is calling through
      // them) and they fall back to originals.* once ctx is null -- nulling it
      // here turned every subsequent timer call into a TypeError, and every
      // clear into a silent no-op. Only release when the slots are all ours
      // again and nothing can reach the wrappers.
      if (clobbered === null) originals = null;
      timers.clear();
      ctx = null;
    },

    /**
     * FR-time refinement: identify callbacks we tracked by tag shape and
     * classify as timer-orphan. `wasCleared` reflects whether we managed
     * to reap the registry entry before FR fired.
     */
    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== T_TIMEOUT && tag.kind !== T_INTERVAL && tag.kind !== T_RAF) return null;
      const stillPending = timers.has(tag.id);
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        timerKind: tag.kind,
        timerId: tag.id,
        wasCleared: stillPending === false,
      };
    },

    /**
     * On-demand scan of pending timers.
     */
    audit() {
      if (ctx === null) return [];
      const findings = [];
      for (const [id, state] of timers) {
        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          const liveId = nodeId(state.ownerHandle);
          if (liveId === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-timer-pending',
              timerKind: state.kind,
              timerId: id,
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-pending',
            timerKind: state.kind,
            timerId: id,
            origin: state.origin,
          });
        }
      }
      return findings;
    },

    // Test-only introspection (underscore-prefixed).
    /**
     * Live resources this kernel is watching. Part of the public kernel
     * contract as of 1.6.0: snapshot() reads it, and a kernel that cannot
     * answer omits it so the count reads null rather than zero.
     */
    count: function () { return kernel._pendingCount(); },

    _pendingCount() { return timers.size; },
  };

  return kernel;
}
