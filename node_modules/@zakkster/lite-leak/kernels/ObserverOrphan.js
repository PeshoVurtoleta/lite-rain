/**
 * @zakkster/lite-leak kernel: observer-orphan
 *
 * Detects and prevents leaks from MutationObserver / ResizeObserver /
 * IntersectionObserver instances that outlive their owner without being
 * explicitly disconnect()ed.
 *
 * Design: replaces each constructor on the target with a wrapper that
 * (a) instruments the returned instance's `disconnect()` for untrack /
 * registry reap; (b) wires `onCleanup(() => instance.disconnect())` when
 * `new Observer()` is called inside an effect/computed body; (c) emits
 * `onWarning` at construction time when outside any owner.
 *
 * Patch surfaces: 'MutationObserver', 'ResizeObserver',
 * 'IntersectionObserver'.
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'observer-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

const OBSERVER_KINDS = ['MutationObserver', 'ResizeObserver', 'IntersectionObserver'];

/**
 * Create the observer-orphan kernel.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   Object whose observer constructors are replaced. Tests pass a mock
 *   target with any subset of the three observer classes.
 * @param {boolean} [options.warnOnNoOwner=true]
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createObserverOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  // observer instance -> state
  const observers = new Map();
  let originals = null;
  let ours = null;
  let claimed = null;

  function makePatchedCtor(kind, OriginalCtor) {
    return function PatchedObserver(cb, ctorOpts) {
      // Construct via Reflect so subclassing rules stay intact if the
      // original was itself subclassed.
      const instance = ctorOpts !== undefined
        ? Reflect.construct(OriginalCtor, [cb, ctorOpts])
        : Reflect.construct(OriginalCtor, [cb]);

      if (ctx === null) return instance;

      const ownerHandle = getOwner();
      const origin = captureStacks ? new Error().stack : null;
      const state = {
        kind: kind,
        instance: instance,
        cb: cb,
        ownerHandle: ownerHandle,
        origin: origin,
        handle: null,
      };

      // Track the callback so FR-refine can classify.
      const handle = ctx.track(cb, function () {}, {
        kind: 'observer',
        observerKind: kind,
      }, { audit: false });
      state.handle = handle;
      observers.set(instance, state);

      // Wrap the instance's disconnect() so we reap on manual disconnect.
      const origDisconnect = instance.disconnect.bind(instance);
      instance.disconnect = function patchedDisconnect() {
        if (ctx !== null) {
          observers.delete(instance);
          ctx.untrack(handle);
        }
        return origDisconnect();
      };

      if (ownerHandle !== undefined) {
        onCleanup(function () {
          if (ctx === null || originals === null) return;
          const s = observers.get(instance);
          if (s === undefined) return; // already disconnected
          observers.delete(instance);
          ctx.untrack(handle);
          origDisconnect();
        });
      } else if (warnOnNoOwner) {
        ctx.emitWarning({
          kind: KIND,
          reason: 'no-owner-set',
          observerKind: kind,
          origin: origin,
        });
      }
      return instance;
    };
  }

  const kernel = {
    name: 'observer-orphan',
    patchSurfaces: OBSERVER_KINDS,
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      originals = {};
      ours = {};
      claimed = [];
      let contested = null;
      for (const kind of OBSERVER_KINDS) {
        const orig = target[kind];
        if (typeof orig !== 'function') continue;
        // Claim each observer constructor per-target so a second kernel instance
        // -- another tracker, a second bundled copy -- is reported loudly rather
        // than silently layering and double-counting every observer.
        if (_claimPatchSurface(target, kind)) claimed.push(kind);
        else { if (contested === null) contested = []; contested.push(kind); }
        originals[kind] = orig;
        ours[kind] = makePatchedCtor(kind, orig);
        target[kind] = ours[kind];
      }
      if (contested !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: contested,
          detail: 'already patched by another lite-leak kernel instance; both are now ' +
            'active, so observer instances will be counted twice',
        });
      }
    },

    uninstall() {
      if (originals === null) return;
      let clobbered = null;
      for (const kind of OBSERVER_KINDS) {
        if (typeof originals[kind] !== 'function') continue;
        // Restore only if the slot is still ours. A third party that wrapped our
        // constructor after us stays in place -- restoring unconditionally would
        // destroy their wrapper and leave the call path broken.
        if (!_restoreIfOurs(target, kind, ours[kind], originals[kind])) {
          if (clobbered === null) clobbered = [];
          clobbered.push(kind);
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
      if (claimed !== null) {
        for (const kind of claimed) _releasePatchSurface(target, kind);
        claimed = null;
      }
      originals = null;
      ours = null;
      observers.clear();
      ctx = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'observer') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        observerKind: tag.observerKind,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      for (const [instance, state] of observers) {
        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          const liveId = nodeId(state.ownerHandle);
          if (liveId === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-observer-pending',
              observerKind: state.kind,
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-pending',
            observerKind: state.kind,
            origin: state.origin,
          });
        }
      }
      return findings;
    },

    /**
     * Live resources this kernel is watching. Part of the public kernel
     * contract as of 1.6.0: snapshot() reads it, and a kernel that cannot
     * answer omits it so the count reads null rather than zero.
     */
    count: function () { return kernel._pendingCount(); },

    _pendingCount() { return observers.size; },
  };

  return kernel;
}
