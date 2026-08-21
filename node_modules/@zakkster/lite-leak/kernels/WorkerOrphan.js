/**
 * @zakkster/lite-leak kernel: worker-orphan
 *
 * Detects Worker / SharedWorker instances that outlive their owner without
 * being terminate()d, and the object URLs minted to construct them.
 *
 * A Worker is not an ordinary object. Dropping the last JS reference does not
 * stop the thread: the agent stays alive while it has pending activity, so a
 * worker that is merely forgotten keeps its thread, its heap and its message
 * queue for the lifetime of the document. That is the leak, and it is invisible
 * to every heap tool that only walks the main-thread graph.
 *
 * Design mirrors observer-orphan: replace the constructor on the target with a
 * wrapper that (a) instruments the instance's terminate() for reap, (b) wires
 * `onCleanup(() => instance.terminate())` when constructed inside an
 * effect/computed body, (c) emits `onWarning` at construction outside any owner.
 *
 * Two departures from observer-orphan, both deliberate:
 *
 *   1. The live registry holds WeakRefs, not strong references. A leak detector
 *      that pins the resources it watches prevents the very collection it is
 *      trying to observe -- the tracked worker could never reach the FR path.
 *      Here a dropped-and-never-terminated Worker is collectable, FR fires, and
 *      refine() classifies it as `worker-orphan`. audit() prunes dead refs as it
 *      walks.
 *
 *   2. Object URLs are attributed, not globally policed. Patching
 *      URL.createObjectURL wholesale would report every image and download blob
 *      in the application as a worker finding -- the same category error that
 *      made timer-orphan model a render loop as a fire-once timer. Instead only
 *      a `blob:` URL actually passed to `new Worker(...)` is recorded, and
 *      URL.revokeObjectURL is patched for bookkeeping alone (it emits nothing on
 *      its own). Note that revoking immediately after construction is correct
 *      and expected -- the worker script is fetched during construction -- so
 *      `@zakkster/lite-worker`, which revokes on the next line, is clean here by
 *      design rather than by luck.
 *
 * Patch surfaces: 'Worker', 'SharedWorker', 'URL.revokeObjectURL'.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'worker-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

const WORKER_KINDS = ['Worker', 'SharedWorker'];

/**
 * Create the worker-orphan kernel.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   Object whose Worker constructors are replaced. Node has no DOM Worker, so
 *   tests pass a mock target exposing any subset of the constructors.
 * @param {boolean} [options.warnOnNoOwner=true]
 *   Emit `onWarning` when a worker is constructed outside any lite-signal owner.
 * @param {boolean} [options.trackObjectURLs=true]
 *   Record `blob:` URLs passed to a worker constructor and patch
 *   URL.revokeObjectURL for bookkeeping, so audit() can report a worker whose
 *   object URL was never revoked. Set false to leave the URL surface untouched.
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createWorkerOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const trackObjectURLs = opts.trackObjectURLs !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  // instance -> state. Weak so the kernel never pins a worker.
  const states = new WeakMap();
  // Set<WeakRef<instance>> for audit enumeration.
  const live = new Set();
  // Object URLs revoked so far, so audit can tell revoked from forgotten.
  const revokedUrls = new Set();

  let originals = null;
  let ours = null;
  let claimed = null;

  /** @private */
  function reap(state) {
    if (state.reaped) return;
    state.reaped = true;
    live.delete(state.ref);
    if (ctx !== null && state.handle !== null) ctx.untrack(state.handle);
  }

  function makePatchedCtor(workerKind, OriginalCtor) {
    return function PatchedWorker(scriptUrl, workerOptions) {
      const instance = workerOptions !== undefined
        ? Reflect.construct(OriginalCtor, [scriptUrl, workerOptions])
        : Reflect.construct(OriginalCtor, [scriptUrl]);

      if (ctx === null) return instance;

      const ownerHandle = getOwner();
      const origin = captureStacks ? new Error().stack : null;
      const blobUrl = (trackObjectURLs && typeof scriptUrl === 'string' &&
        scriptUrl.slice(0, 5) === 'blob:') ? scriptUrl : null;

      const state = {
        workerKind: workerKind,
        ownerHandle: ownerHandle,
        origin: origin,
        blobUrl: blobUrl,
        handle: null,
        ref: null,
        reaped: false,
      };
      state.ref = new WeakRef(instance);

      // Track the instance itself: a worker dropped without terminate() is
      // exactly the leak, and the FR path is the terminus that proves it.
      // Neither the cleanup nor the tag closes over `instance` -- doing so
      // would defeat finalization (held-value contract).
      state.handle = ctx.track(instance, function () {}, {
        kind: 'worker',
        workerKind: workerKind,
      }, { audit: false });

      states.set(instance, state);
      live.add(state.ref);

      // Reap on manual terminate(). SharedWorker has no terminate(); its port
      // is closed instead, so only wrap what exists.
      if (typeof instance.terminate === 'function') {
        const origTerminate = instance.terminate.bind(instance);
        instance.terminate = function patchedTerminate() {
          if (ctx !== null) reap(state);
          return origTerminate();
        };
      }

      if (ownerHandle !== undefined) {
        onCleanup(function () {
          if (ctx === null || originals === null) return;
          const s = states.get(instance);
          if (s === undefined || s.reaped) return;
          if (typeof instance.terminate === 'function') {
            reap(s);
            instance.terminate();
            return;
          }
          // No terminate() to call -- a SharedWorker cannot be stopped from the
          // constructing context, you can only close your port. The cascade ran
          // and the agent is still alive, so the registration deliberately
          // stays: audit() reports it as owner-disposed-worker-live rather than
          // reporting clean on a worker nothing can stop.
        });
      } else if (warnOnNoOwner) {
        ctx.emitWarning({
          kind: KIND,
          reason: 'no-owner-set',
          workerKind: workerKind,
          origin: origin,
        });
      }
      return instance;
    };
  }

  const kernel = {
    name: 'worker-orphan',
    patchSurfaces: trackObjectURLs
      ? WORKER_KINDS.concat(['URL.revokeObjectURL'])
      : WORKER_KINDS.slice(),
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      originals = Object.create(null);
      ours = Object.create(null);
      claimed = [];
      let contested = null;

      for (const workerKind of WORKER_KINDS) {
        const orig = target[workerKind];
        if (typeof orig !== 'function') continue;
        if (_claimPatchSurface(target, workerKind)) claimed.push(workerKind);
        else { if (contested === null) contested = []; contested.push(workerKind); }
        originals[workerKind] = orig;
        ours[workerKind] = makePatchedCtor(workerKind, orig);
        target[workerKind] = ours[workerKind];
      }

      // Bookkeeping only: records revocations so audit() can distinguish a
      // forgotten object URL from a correctly revoked one. Emits nothing.
      const urlObj = target.URL;
      if (trackObjectURLs && urlObj && typeof urlObj.revokeObjectURL === 'function') {
        if (_claimPatchSurface(urlObj, 'revokeObjectURL')) claimed.push('URL.revokeObjectURL');
        else { if (contested === null) contested = []; contested.push('URL.revokeObjectURL'); }
        const origRevoke = urlObj.revokeObjectURL;
        originals.revokeObjectURL = origRevoke;
        ours.revokeObjectURL = function patchedRevoke(url) {
          if (typeof url === 'string') revokedUrls.add(url);
          return origRevoke.call(this, url);
        };
        urlObj.revokeObjectURL = ours.revokeObjectURL;
      }

      if (contested !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: contested,
          detail: 'already patched by another lite-leak kernel instance; both are now ' +
            'active, so workers will be double-counted',
        });
      }
    },

    uninstall() {
      if (originals === null) return;
      let clobbered = null;

      for (const workerKind of WORKER_KINDS) {
        if (typeof originals[workerKind] !== 'function') continue;
        if (!_restoreIfOurs(target, workerKind, ours[workerKind], originals[workerKind])) {
          if (clobbered === null) clobbered = [];
          clobbered.push(workerKind);
        }
      }
      const urlObj = target.URL;
      if (typeof originals.revokeObjectURL === 'function' && urlObj) {
        if (!_restoreIfOurs(urlObj, 'revokeObjectURL', ours.revokeObjectURL, originals.revokeObjectURL)) {
          if (clobbered === null) clobbered = [];
          clobbered.push('URL.revokeObjectURL');
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
        for (const s of claimed) {
          if (s === 'URL.revokeObjectURL') {
            if (target.URL) _releasePatchSurface(target.URL, 'revokeObjectURL');
          } else {
            _releasePatchSurface(target, s);
          }
        }
        claimed = null;
      }
      ours = null;
      live.clear();
      revokedUrls.clear();
      ctx = null;
      if (clobbered === null) originals = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'worker') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        workerKind: tag.workerKind,
        // Reaching FR at all means terminate() never ran: the reap path
        // untracks, which cancels the registration before it can fire.
        wasTerminated: false,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      let dead = null;

      for (const ref of live) {
        const instance = ref.deref();
        if (instance === undefined) {
          // Collected without terminate(). The FR path reports the leak; drop
          // the enumeration entry so the walk stays bounded.
          if (dead === null) dead = [];
          dead.push(ref);
          continue;
        }
        const state = states.get(instance);
        if (state === undefined || state.reaped) continue;

        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          if (nodeId(state.ownerHandle) === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-worker-live',
              workerKind: state.workerKind,
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-worker-live',
            workerKind: state.workerKind,
            origin: state.origin,
          });
        }

        if (state.blobUrl !== null && !revokedUrls.has(state.blobUrl)) {
          findings.push({
            kind: KIND,
            reason: 'blob-url-unrevoked',
            workerKind: state.workerKind,
            origin: state.origin,
          });
        }
      }

      if (dead !== null) for (let i = 0; i < dead.length; i++) live.delete(dead[i]);
      return findings;
    },

    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'no-owner-set') {
        return 'A Worker was constructed outside any lite-signal owner. ' +
               'Dropping the reference does not stop the thread -- it runs ' +
               'until the document unloads. Construct it inside an effect() so ' +
               'terminate() is called on disposal, or own it explicitly ' +
               '(@zakkster/lite-worker: keep the handle and call destroy()).';
      }
      if (finding.reason === 'no-owner-worker-live') {
        return 'A live worker has no owner attribution and no lifecycle handle, ' +
               'so nothing will terminate it. Move construction inside an ' +
               'effect() body, or hold the handle and terminate it from the ' +
               'same scope that created it.';
      }
      if (finding.reason === 'owner-disposed-worker-live') {
        return 'A worker is still running although its origin owner was ' +
               'disposed. The auto-terminate onCleanup did not fire, which ' +
               'points to a broken owner cascade or a worker re-created after ' +
               'disposal. Terminate it explicitly.';
      }
      if (finding.reason === 'blob-url-unrevoked') {
        return 'The blob: URL used to construct this worker was never revoked. ' +
               'The worker script is fetched during construction, so revoke it ' +
               'on the next line: URL.revokeObjectURL(url). Each un-revoked URL ' +
               'pins its Blob for the lifetime of the document.';
      }
      return null;
    },

    /**
     * Live resources this kernel is watching. Part of the public kernel
     * contract as of 1.6.0: snapshot() reads it, and a kernel that cannot
     * answer omits it so the count reads null rather than zero.
     */
    count: function () { return kernel._liveCount(); },

    _liveCount() {
      let n = 0;
      for (const ref of live) if (ref.deref() !== undefined) n++;
      return n;
    },
  };

  return kernel;
}
