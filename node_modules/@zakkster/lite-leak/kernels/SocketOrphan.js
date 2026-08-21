/**
 * @zakkster/lite-leak kernel: socket-orphan
 *
 * Detects WebSocket / EventSource connections that outlive their owner without
 * being close()d.
 *
 * An open socket is held by the network stack, not by your JavaScript. Dropping
 * the reference leaves the connection open, the server-side session live, and
 * -- for EventSource -- the browser reconnecting on a timer forever. A
 * component that opens a socket on mount and forgets it on unmount leaks a
 * connection per mount, which is why this shows up as "the app gets slower the
 * longer you navigate" rather than as a heap graph anyone can read.
 *
 * Same shape as worker-orphan: patch the constructor, instrument close() for
 * reap, wire `onCleanup(() => socket.close())` when constructed inside an
 * effect/computed body, warn at construction outside any owner. The live
 * registry holds WeakRefs so the kernel never pins a socket it is watching.
 *
 * audit() reports by readyState, not by bookkeeping alone: a socket the peer
 * closed is not a leak, so only a connection still CONNECTING or OPEN counts.
 *
 * In-house consumer: `@zakkster/lite-ws`.
 *
 * Patch surfaces: 'WebSocket', 'EventSource'.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'socket-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

const SOCKET_KINDS = ['WebSocket', 'EventSource'];

// readyState values shared by both interfaces for the states we care about.
const CLOSED = 3;

/**
 * Create the socket-orphan kernel.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   Object whose socket constructors are replaced. Tests pass a mock target
 *   exposing any subset of the constructors.
 * @param {boolean} [options.warnOnNoOwner=true]
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createSocketOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  const states = new WeakMap();
  const live = new Set();

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

  function makePatchedCtor(socketKind, OriginalCtor) {
    return function PatchedSocket(url, protocols) {
      const instance = protocols !== undefined
        ? Reflect.construct(OriginalCtor, [url, protocols])
        : Reflect.construct(OriginalCtor, [url]);

      if (ctx === null) return instance;

      const ownerHandle = getOwner();
      const origin = captureStacks ? new Error().stack : null;
      const state = {
        socketKind: socketKind,
        ownerHandle: ownerHandle,
        origin: origin,
        handle: null,
        ref: null,
        reaped: false,
      };
      state.ref = new WeakRef(instance);
      state.handle = ctx.track(instance, function () {}, {
        kind: 'socket',
        socketKind: socketKind,
      }, { audit: false });
      states.set(instance, state);
      live.add(state.ref);

      if (typeof instance.close === 'function') {
        const origClose = instance.close.bind(instance);
        instance.close = function patchedClose() {
          if (ctx !== null) reap(state);
          return origClose.apply(null, arguments);
        };
      }

      if (ownerHandle !== undefined) {
        onCleanup(function () {
          if (ctx === null || originals === null) return;
          const s = states.get(instance);
          if (s === undefined || s.reaped) return;
          reap(s);
          try {
            if (typeof instance.close === 'function') instance.close();
          } catch (_e) { /* already closing */ }
        });
      } else if (warnOnNoOwner) {
        ctx.emitWarning({
          kind: KIND,
          reason: 'no-owner-open',
          socketKind: socketKind,
          origin: origin,
        });
      }
      return instance;
    };
  }

  const kernel = {
    name: 'socket-orphan',
    patchSurfaces: SOCKET_KINDS.slice(),
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      originals = Object.create(null);
      ours = Object.create(null);
      claimed = [];
      let contested = null;

      for (const socketKind of SOCKET_KINDS) {
        const orig = target[socketKind];
        if (typeof orig !== 'function') continue;
        if (_claimPatchSurface(target, socketKind)) claimed.push(socketKind);
        else { if (contested === null) contested = []; contested.push(socketKind); }
        originals[socketKind] = orig;
        ours[socketKind] = makePatchedCtor(socketKind, orig);
        target[socketKind] = ours[socketKind];
      }

      if (contested !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: contested,
          detail: 'already patched by another lite-leak kernel instance; both are now ' +
            'active, so connections will be double-counted',
        });
      }
    },

    uninstall() {
      if (originals === null) return;
      let clobbered = null;
      for (const socketKind of SOCKET_KINDS) {
        if (typeof originals[socketKind] !== 'function') continue;
        if (!_restoreIfOurs(target, socketKind, ours[socketKind], originals[socketKind])) {
          if (clobbered === null) clobbered = [];
          clobbered.push(socketKind);
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
        for (const s of claimed) _releasePatchSurface(target, s);
        claimed = null;
      }
      ours = null;
      live.clear();
      ctx = null;
      if (clobbered === null) originals = null;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'socket') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        socketKind: tag.socketKind,
        wasClosed: false,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      let dead = null;

      for (const ref of live) {
        const socket = ref.deref();
        if (socket === undefined) {
          if (dead === null) dead = [];
          dead.push(ref);
          continue;
        }
        const state = states.get(socket);
        if (state === undefined || state.reaped) continue;

        // A socket the peer closed is not a leak. Only a live connection is.
        if (typeof socket.readyState === 'number' && socket.readyState === CLOSED) continue;

        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          if (nodeId(state.ownerHandle) === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-socket-open',
              socketKind: state.socketKind,
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-socket-open',
            socketKind: state.socketKind,
            origin: state.origin,
          });
        }
      }

      if (dead !== null) for (let i = 0; i < dead.length; i++) live.delete(dead[i]);
      return findings;
    },

    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'no-owner-open') {
        return 'A socket was opened outside any lite-signal owner. Dropping the ' +
               'reference does not close the connection -- the socket stays ' +
               'open and an EventSource will keep reconnecting. Open it inside ' +
               'an effect() so close() runs on disposal.';
      }
      if (finding.reason === 'no-owner-socket-open') {
        return 'An open connection has no owner attribution, so nothing will ' +
               'close it. Each navigation that repeats this opens another one.';
      }
      if (finding.reason === 'owner-disposed-socket-open') {
        return 'A socket is still open although its origin owner was disposed. ' +
               'The auto-close onCleanup did not fire, which points to a broken ' +
               'owner cascade. Close it explicitly.';
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
