/**
 * @zakkster/lite-leak kernel: async-retention
 *
 * Detects AbortController instances whose lifecycle is not attributable to
 * any lite-signal owner. Follows the same shape as timer-orphan and
 * observer-orphan: patch a constructor, auto-abort on owner disposal, warn
 * at construction time when outside any owner, refine FR reports on
 * tracked controller records.
 *
 * Interoperates with @zakkster/lite-await's structural cleanup contract:
 * lite-await's own AbortController usage always wires abort into the
 * settlement path, so kernels never fire on well-behaved lite-await code.
 * The kernel exists to flag manual `new AbortController()` usage that
 * doesn't follow the discipline.
 *
 * Patch surface: 'AbortController'.
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'async-retention';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

export function createAsyncRetentionKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  // controller -> state
  const controllers = new Map();
  let originalCtor = null;
  let ourCtor = null;
  let claimed = false;

  function makePatchedCtor(OriginalCtor) {
    return function PatchedAbortController() {
      const instance = Reflect.construct(OriginalCtor, arguments);
      if (ctx === null) return instance;

      const ownerHandle = getOwner();
      const origin = captureStacks ? new Error().stack : null;
      const state = {
        instance: instance,
        ownerHandle: ownerHandle,
        origin: origin,
        handle: null,
      };

      // Track the controller so FR-refine can classify.
      const handle = ctx.track(instance, function () {}, {
        kind: 'abort-controller',
      }, { audit: false });
      state.handle = handle;
      controllers.set(instance, state);

      // Wrap abort() to reap the registry.
      const origAbort = instance.abort.bind(instance);
      instance.abort = function patchedAbort(reason) {
        if (ctx !== null) {
          controllers.delete(instance);
          ctx.untrack(handle);
        }
        return origAbort(reason);
      };

      if (ownerHandle !== undefined) {
        onCleanup(function () {
          if (ctx === null || originalCtor === null) return;
          const s = controllers.get(instance);
          if (s === undefined) return; // already aborted
          controllers.delete(instance);
          ctx.untrack(handle);
          try { origAbort(new Error('lite-leak: owner disposed')); } catch (_e) { /* swallowed */ }
        });
      } else if (warnOnNoOwner) {
        ctx.emitWarning({
          kind: KIND,
          reason: 'no-owner-set',
          origin: origin,
        });
      }
      return instance;
    };
  }

  const kernel = {
    name: 'async-retention',
    patchSurfaces: ['AbortController'],
    priority: priority,

    install(kernelCtx) {
      // Target-scoped claim: the tracker's own patchSurfaces guard only covers
      // ONE tracker, so two trackers could both wrap the same AbortController.
      originalCtor = target.AbortController;
      if (typeof originalCtor === 'function') {
        claimed = _claimPatchSurface(target, 'AbortController');
        ourCtor = makePatchedCtor(originalCtor);
        target.AbortController = ourCtor;
      }
      ctx = kernelCtx;
      if (originalCtor !== undefined && typeof originalCtor === 'function' && !claimed) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: ['AbortController'],
          detail: 'already patched by another lite-leak kernel instance; both are now active',
        });
      }
    },

    uninstall() {
      if (originalCtor === null) return;
      let leftInPlace = false;
      if (typeof originalCtor === 'function') {
        // Restore only if the slot is still ours; a later wrapper stays.
        leftInPlace = !_restoreIfOurs(target, 'AbortController', ourCtor, originalCtor);
        if (leftInPlace && ctx !== null) {
          ctx.emitFinding({
            kind: KIND,
            reason: 'patch-layered',
            surfaces: ['AbortController'],
            detail: 'another wrapper was installed over this after this kernel; left in place',
          });
        }
      }
      if (claimed) { _releasePatchSurface(target, 'AbortController'); claimed = false; }
      ourCtor = null;
      controllers.clear();
      ctx = null;
      // A wrapper we left installed still constructs through originalCtor.
      if (!leftInPlace) originalCtor = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'abort-controller') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      for (const [, state] of controllers) {
        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          const liveId = nodeId(state.ownerHandle);
          if (liveId === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-controller-pending',
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-pending',
            origin: state.origin,
          });
        }
      }
      return findings;
    },

    /**
     * Kernel-specific advisory generator. Used by remediate() at the tracker
     * level to produce human-readable remediation text.
     */
    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'no-owner-set') {
        return 'AbortController created outside any lite-signal owner. Consider ' +
               'creating it inside an effect() so it aborts automatically on ' +
               'disposal, or wire abort() into your cleanup path explicitly. ' +
               'For promise-based flows, see @zakkster/lite-await which encodes ' +
               'the structural cleanup contract.';
      }
      if (finding.reason === 'no-owner-pending') {
        return 'A pending AbortController has no owner attribution and no ' +
               'lifecycle handle. If the associated async work outlives its ' +
               'intended scope, its callback closures may retain arbitrary ' +
               'graph state. Consider abort()ing when the caller-defined ' +
               'lifecycle ends.';
      }
      if (finding.reason === 'owner-disposed-controller-pending') {
        return 'A tracked AbortController survived past its owner disposal ' +
               'without being abort()ed. This suggests the kernel\'s ' +
               'auto-abort onCleanup did not fire, which is either an engine ' +
               'anomaly or manual owner-cascade tampering.';
      }
      return null;
    },

    /**
     * Live resources this kernel is watching. Part of the public kernel
     * contract as of 1.6.0: snapshot() reads it, and a kernel that cannot
     * answer omits it so the count reads null rather than zero.
     */
    count: function () { return kernel._pendingCount(); },

    _pendingCount() { return controllers.size; },
  };

  return kernel;
}
