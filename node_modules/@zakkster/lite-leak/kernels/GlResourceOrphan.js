/**
 * @zakkster/lite-leak kernel: gl-resource-orphan
 *
 * Detects WebGL resources -- buffers, textures, framebuffers, renderbuffers,
 * shaders, programs, vertex arrays, samplers -- that outlive their owner
 * without being deleted.
 *
 * This is the purest case of the retention rule the whole package exists for. A
 * WebGLBuffer is a small JS wrapper around memory owned by the driver. Dropping
 * the last JS reference frees the wrapper and nothing else: the VRAM stays
 * allocated until `deleteBuffer()` is called or the context is lost. So a heap
 * snapshot is not merely unhelpful here, it is actively misleading -- the JS
 * side can look perfectly clean while a texture atlas leaks a few megabytes of
 * device memory per scene reload, and the failure presents as a GPU-side
 * slowdown or an out-of-memory context loss with nothing in the heap profile to
 * explain it.
 *
 * Design: patch the *factory* methods on a specific context object rather than
 * a global constructor. Unlike every other kernel here, the target is an
 * instance -- an application can hold several contexts (a main scene, a picking
 * pass, an offscreen thumbnailer), and each needs its own kernel.
 *
 *   - `create*()` registers the returned resource.
 *   - `delete*(resource)` reaps it.
 *   - Created inside an effect/computed body, the resource is deleted on owner
 *     disposal.
 *   - Created outside any owner, `onWarning` fires at creation time.
 *
 * Two context-specific rules:
 *
 *   1. `audit()` returns nothing once `gl.isContextLost()` is true. A lost
 *      context has already destroyed every resource it owned, so reporting them
 *      would be reporting a leak that the driver already collected -- the same
 *      reasoning that makes socket-orphan skip a peer-closed socket.
 *
 *   2. The tracker's `patchSurfaces` guard is a flat set of strings, so two
 *      kernels over two *different* contexts would collide on `createBuffer`
 *      and be rejected as a conflict that does not exist. Surfaces are
 *      therefore namespaced by a per-kernel `label` (auto-unique when not
 *      given). Genuine double-install on the *same* context is still caught,
 *      because that check is target-scoped (`_claimPatchSurface`) and keyed by
 *      the context object itself, not by the surface name.
 *
 * In-house consumer: `@zakkster/lite-gl` v1.3.0, whose instanced pipelines
 * create buffers, textures and programs and delete them on dispose.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'gl-resource-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

/**
 * Factory method -> delete method, and the resource kind reported in findings.
 * WebGL2-only entries are patched when the context exposes them.
 * @private
 */
const GL_RESOURCES = [
  { create: 'createBuffer', del: 'deleteBuffer', kind: 'buffer' },
  { create: 'createTexture', del: 'deleteTexture', kind: 'texture' },
  { create: 'createFramebuffer', del: 'deleteFramebuffer', kind: 'framebuffer' },
  { create: 'createRenderbuffer', del: 'deleteRenderbuffer', kind: 'renderbuffer' },
  { create: 'createShader', del: 'deleteShader', kind: 'shader' },
  { create: 'createProgram', del: 'deleteProgram', kind: 'program' },
  { create: 'createVertexArray', del: 'deleteVertexArray', kind: 'vertexArray' },
  { create: 'createSampler', del: 'deleteSampler', kind: 'sampler' },
  { create: 'createQuery', del: 'deleteQuery', kind: 'query' },
];

let labelSeq = 0;

/**
 * Create the gl-resource-orphan kernel.
 *
 * @param {object} options
 * @param {object} options.gl
 *   The WebGL context to instrument. Required -- there is no sensible global
 *   default, and guessing one would instrument the wrong context in any app
 *   with more than one.
 * @param {string} [options.label]
 *   Namespace for this kernel's patch surfaces, so several contexts can be
 *   instrumented at once. Auto-generated when omitted.
 * @param {boolean} [options.warnOnNoOwner=true]
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createGlResourceOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const gl = opts.gl;
  if (gl === null || typeof gl !== 'object') {
    throw new TypeError(
      'createGlResourceOrphanKernel: options.gl must be a WebGL context object. ' +
      'There is no global default -- an application may hold several contexts, ' +
      'and instrumenting the wrong one would report clean forever.'
    );
  }
  if (opts.label !== undefined && opts.label !== null && typeof opts.label !== 'string') {
    throw new TypeError('createGlResourceOrphanKernel: options.label must be a string when present.');
  }
  const label = (typeof opts.label === 'string' && opts.label.length > 0)
    ? opts.label
    : 'gl#' + (++labelSeq);
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  // resource -> state. Weak: the kernel must never pin a GPU handle.
  const states = new WeakMap();
  // Set<WeakRef<resource>> for audit enumeration.
  const live = new Set();

  let originals = null;
  let ours = null;
  let claimed = null;
  // Resource kinds actually present on this context, resolved at install.
  let present = null;

  /** @private */
  function reap(state) {
    if (state.reaped) return;
    state.reaped = true;
    live.delete(state.ref);
    if (ctx !== null && state.handle !== null) ctx.untrack(state.handle);
  }

  /** @private */
  function register(resource, resourceKind, deleteName) {
    if (resource === null || typeof resource !== 'object') return;   // GL returns null on failure
    const ownerHandle = getOwner();
    const origin = captureStacks ? new Error().stack : null;
    const state = {
      resourceKind: resourceKind,
      ownerHandle: ownerHandle,
      origin: origin,
      handle: null,
      ref: null,
      reaped: false,
    };
    state.ref = new WeakRef(resource);
    state.handle = ctx.track(resource, function () {}, {
      kind: 'gl-resource',
      resourceKind: resourceKind,
    }, { audit: false });
    states.set(resource, state);
    live.add(state.ref);

    if (ownerHandle !== undefined) {
      onCleanup(function () {
        if (ctx === null || originals === null) return;
        const s = states.get(resource);
        if (s === undefined || s.reaped) return;
        reap(s);
        // Releasing device memory is the entire point, so do it even if the
        // context is mid-teardown; a lost context makes this a documented no-op.
        try {
          if (typeof gl[deleteName] === 'function' && !isLost()) gl[deleteName](resource);
        } catch (_e) { /* context lost or resource already deleted */ }
      });
    } else if (warnOnNoOwner) {
      ctx.emitWarning({
        kind: KIND,
        reason: 'no-owner-create',
        resourceKind: resourceKind,
        origin: origin,
      });
    }
  }

  /** @private */
  function isLost() {
    try {
      return typeof gl.isContextLost === 'function' && gl.isContextLost() === true;
    } catch (_e) {
      return false;
    }
  }

  const kernel = {
    // Namespaced by label so several contexts can be instrumented on one
    // tracker: registerKernel enforces unique kernel NAMES as well as unique
    // patch surfaces. The reported finding.kind stays 'gl-resource-orphan'
    // regardless, so auditByKind() and remediate() are unaffected by the label.
    name: 'gl-resource-orphan:' + label,
    patchSurfaces: [],   // filled at construction below
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      originals = Object.create(null);
      ours = Object.create(null);
      claimed = [];
      present = [];
      let contested = null;

      for (let i = 0; i < GL_RESOURCES.length; i++) {
        const spec = GL_RESOURCES[i];
        const origCreate = gl[spec.create];
        const origDelete = gl[spec.del];
        if (typeof origCreate !== 'function' || typeof origDelete !== 'function') continue;
        present.push(spec);

        for (const prop of [spec.create, spec.del]) {
          if (_claimPatchSurface(gl, prop)) claimed.push(prop);
          else { if (contested === null) contested = []; contested.push(label + '.' + prop); }
        }

        originals[spec.create] = origCreate;
        originals[spec.del] = origDelete;

        ours[spec.create] = function patchedCreate() {
          const resource = origCreate.apply(gl, arguments);
          if (ctx !== null) {
            try { register(resource, spec.kind, spec.del); } catch (e) { ctx.reportError(e, KIND); }
          }
          return resource;
        };
        gl[spec.create] = ours[spec.create];

        ours[spec.del] = function patchedDelete(resource) {
          if (ctx !== null && resource !== null && typeof resource === 'object') {
            const state = states.get(resource);
            if (state !== undefined && !state.reaped) reap(state);
          }
          return origDelete.apply(gl, arguments);
        };
        gl[spec.del] = ours[spec.del];
      }

      if (contested !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: contested,
          detail: 'this context is already instrumented by another lite-leak kernel ' +
            'instance; both are active, so GPU resources will be double-counted',
        });
      }
    },

    uninstall() {
      if (originals === null) { ctx = null; return; }
      let clobbered = null;

      for (let i = 0; i < GL_RESOURCES.length; i++) {
        const spec = GL_RESOURCES[i];
        for (const prop of [spec.create, spec.del]) {
          if (typeof originals[prop] !== 'function') continue;
          if (!_restoreIfOurs(gl, prop, ours[prop], originals[prop])) {
            if (clobbered === null) clobbered = [];
            clobbered.push(label + '.' + prop);
          }
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
        for (let i = 0; i < claimed.length; i++) _releasePatchSurface(gl, claimed[i]);
        claimed = null;
      }
      ours = null;
      present = null;
      live.clear();
      ctx = null;
      if (clobbered === null) originals = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'gl-resource') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        resourceKind: tag.resourceKind,
        // Reaching FR means the JS wrapper was collected while still
        // registered: delete*() never ran, so the device memory outlived it.
        wasDeleted: false,
      };
    },

    audit() {
      if (ctx === null) return [];
      // A lost context has already destroyed everything it owned. Reporting
      // those resources would be reporting a leak the driver already collected.
      if (isLost()) return [];

      const findings = [];
      let dead = null;

      for (const ref of live) {
        const resource = ref.deref();
        if (resource === undefined) {
          if (dead === null) dead = [];
          dead.push(ref);
          continue;
        }
        const state = states.get(resource);
        if (state === undefined || state.reaped) continue;

        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          if (nodeId(state.ownerHandle) === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-resource-live',
              resourceKind: state.resourceKind,
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-resource-live',
            resourceKind: state.resourceKind,
            origin: state.origin,
          });
        }
      }

      if (dead !== null) for (let i = 0; i < dead.length; i++) live.delete(dead[i]);
      return findings;
    },

    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'no-owner-create') {
        return 'A WebGL resource was created outside any lite-signal owner. ' +
               'Dropping the JS reference frees the wrapper, not the device ' +
               'memory -- the allocation survives until delete*() or context ' +
               'loss. Create it inside an effect() so it is deleted on ' +
               'disposal, or tear it down explicitly (@zakkster/lite-gl: ' +
               'dispose the pipeline that owns it).';
      }
      if (finding.reason === 'no-owner-resource-live') {
        return 'A live GPU resource has no owner attribution, so nothing will ' +
               'delete it. It holds device memory for the life of the context, ' +
               'and repeated scene reloads accumulate one allocation per pass ' +
               'with nothing visible in a JS heap snapshot.';
      }
      if (finding.reason === 'owner-disposed-resource-live') {
        return 'A GPU resource is still allocated although its origin owner was ' +
               'disposed. The auto-delete onCleanup did not run -- check for a ' +
               'broken owner cascade, or a resource re-created after disposal. ' +
               'Delete it explicitly.';
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

    /** Resource kinds this context actually exposes. @private */
    _presentKinds() {
      if (present === null) return [];
      const out = [];
      for (let i = 0; i < present.length; i++) out.push(present[i].kind);
      return out;
    },
  };

  // Namespace the tracker-level surface names so two contexts do not collide.
  const surfaces = [];
  for (let i = 0; i < GL_RESOURCES.length; i++) {
    const spec = GL_RESOURCES[i];
    if (typeof gl[spec.create] === 'function' && typeof gl[spec.del] === 'function') {
      surfaces.push(label + '.' + spec.create, label + '.' + spec.del);
    }
  }
  kernel.patchSurfaces = surfaces;
  kernel._label = label;

  return kernel;
}
