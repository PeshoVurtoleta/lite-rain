/**
 * @zakkster/lite-leak kernel: audio-node
 *
 * Detects WebAudio nodes that stay wired into the render graph after their
 * owner is gone, and scheduled sources that were started and never stopped.
 *
 * The retention rule that makes this worth a kernel: a connected AudioNode is
 * referenced by the audio graph, not just by your JavaScript. Dropping the last
 * JS reference to a node that is still connected -- and, for a source, still
 * playing -- frees nothing. The context keeps rendering it. So the ordinary
 * "let it fall out of scope" discipline that works for plain objects is exactly
 * wrong here, and a heap snapshot showing no JS references is not evidence of
 * anything.
 *
 * That is why the hook is `connect()` rather than the factory methods. A node
 * that is constructed and never connected is inert and collectable; a node
 * becomes retained at the moment it joins the graph, and stops being retained
 * when it fully leaves it. Patching `createGain` and friends would tag hundreds
 * of harmless nodes and miss the one property that matters.
 *
 * Detection:
 *   - `onWarning` at connect-time when a node joins the graph outside any owner.
 *   - `onCleanup(() => node.disconnect())` when connected inside an
 *     effect/computed body.
 *   - `audit()` reports still-connected nodes with no owner or a disposed
 *     owner, and sources started but never stopped.
 *
 * `disconnect()` with no arguments severs every output and reaps. A partial
 * `disconnect(destination)` leaves the node in the graph, so tracking continues
 * -- treating a partial disconnect as a full teardown would report clean on a
 * node that is still audible.
 *
 * In-house consumer: `@zakkster/lite-audio` v1.1.0, whose `destroy()`
 * disconnects sources, crossfade and volume gains, bus gains and the master
 * gain. Installing this kernel around a LiteAudio lifecycle should produce an
 * empty audit() after destroy(); anything left is a real graph leak.
 *
 * Patch surfaces: 'AudioNode.connect', 'AudioNode.disconnect',
 * 'AudioScheduledSourceNode.start', 'AudioScheduledSourceNode.stop'.
 *
 * Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License
 */

import { getOwner, onCleanup, nodeId } from '@zakkster/lite-signal';
import { _claimPatchSurface, _releasePatchSurface, _restoreIfOurs } from '../Leak.js';

const KIND = 'audio-node';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

/**
 * Create the audio-node kernel.
 *
 * @param {object} [options]
 * @param {object} [options.target=globalThis]
 *   Object exposing `AudioNode` and optionally `AudioScheduledSourceNode`.
 *   Node has no WebAudio, so tests pass a mock target with those classes.
 * @param {boolean} [options.warnOnNoOwner=true]
 *   Emit `onWarning` when a node is connected outside any lite-signal owner.
 * @param {boolean} [options.trackSources=true]
 *   Also patch start()/stop() on AudioScheduledSourceNode to report sources
 *   that were started and never stopped.
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createAudioNodeKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const target = opts.target || globalThis;
  const warnOnNoOwner = opts.warnOnNoOwner !== false;
  const trackSources = opts.trackSources !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;

  let ctx = null;
  // node -> state. Weak: the kernel must not pin the graph it inspects.
  const states = new WeakMap();
  // Set<WeakRef<node>> for audit enumeration.
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

  /**
   * Register a node the first time it joins the graph.
   * @private
   */
  function onConnect(node) {
    let state = states.get(node);
    if (state !== undefined && !state.reaped) {
      state.connections++;
      return;
    }
    const ownerHandle = getOwner();
    const origin = captureStacks ? new Error().stack : null;
    state = {
      ownerHandle: ownerHandle,
      origin: origin,
      connections: 1,
      started: false,
      stopped: false,
      handle: null,
      ref: null,
      reaped: false,
    };
    state.ref = new WeakRef(node);
    state.handle = ctx.track(node, function () {}, { kind: 'audio-node' }, { audit: false });
    states.set(node, state);
    live.add(state.ref);

    if (ownerHandle !== undefined) {
      onCleanup(function () {
        if (ctx === null || originals === null) return;
        const s = states.get(node);
        if (s === undefined || s.reaped) return;
        reap(s);
        // Sever the node from the graph, and silence it if it is a source.
        // Leaving a started source connected is the audible half of the leak.
        try {
          if (trackSources && s.started && !s.stopped && typeof node.stop === 'function') {
            node.stop();
          }
        } catch (_e) { /* already stopped / not startable */ }
        try {
          if (typeof node.disconnect === 'function') node.disconnect();
        } catch (_e) { /* already disconnected */ }
      });
    } else if (warnOnNoOwner) {
      ctx.emitWarning({
        kind: KIND,
        reason: 'no-owner-connect',
        origin: origin,
      });
    }
  }

  const kernel = {
    name: 'audio-node',
    get patchSurfaces() {
      const s = ['AudioNode.connect', 'AudioNode.disconnect'];
      if (trackSources) s.push('AudioScheduledSourceNode.start', 'AudioScheduledSourceNode.stop');
      return s;
    },
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      const NodeCtor = target.AudioNode;
      if (typeof NodeCtor !== 'function') { originals = null; return; }
      const SourceCtor = trackSources ? target.AudioScheduledSourceNode : undefined;

      originals = Object.create(null);
      ours = Object.create(null);
      claimed = [];
      let contested = null;

      const nodeProto = NodeCtor.prototype;
      for (const prop of ['connect', 'disconnect']) {
        if (_claimPatchSurface(nodeProto, prop)) claimed.push({ obj: nodeProto, prop: prop });
        else { if (contested === null) contested = []; contested.push('AudioNode.' + prop); }
      }

      const origConnect = nodeProto.connect;
      const origDisconnect = nodeProto.disconnect;
      originals.connect = origConnect;
      originals.disconnect = origDisconnect;

      ours.connect = function patchedConnect(destination, output, input) {
        const result = arguments.length === 0
          ? origConnect.call(this)
          : origConnect.call(this, destination, output, input);
        if (ctx !== null) {
          try { onConnect(this); } catch (e) { ctx.reportError(e, KIND); }
        }
        return result;
      };
      nodeProto.connect = ours.connect;

      ours.disconnect = function patchedDisconnect() {
        // Only a full disconnect() removes the node from the graph. A partial
        // disconnect(dest) leaves it audible, so it must keep its registration.
        if (ctx !== null && arguments.length === 0) {
          const state = states.get(this);
          if (state !== undefined && !state.reaped) reap(state);
        }
        return arguments.length === 0
          ? origDisconnect.call(this)
          : origDisconnect.apply(this, arguments);
      };
      nodeProto.disconnect = ours.disconnect;

      if (trackSources && typeof SourceCtor === 'function') {
        const srcProto = SourceCtor.prototype;
        for (const prop of ['start', 'stop']) {
          if (typeof srcProto[prop] !== 'function') continue;
          if (_claimPatchSurface(srcProto, prop)) claimed.push({ obj: srcProto, prop: prop });
          else { if (contested === null) contested = []; contested.push('AudioScheduledSourceNode.' + prop); }
        }
        const origStart = srcProto.start;
        const origStop = srcProto.stop;
        if (typeof origStart === 'function') {
          originals.start = origStart;
          ours.start = function patchedStart() {
            const state = states.get(this);
            if (state !== undefined) state.started = true;
            return origStart.apply(this, arguments);
          };
          srcProto.start = ours.start;
        }
        if (typeof origStop === 'function') {
          originals.stop = origStop;
          ours.stop = function patchedStop() {
            const state = states.get(this);
            if (state !== undefined) state.stopped = true;
            return origStop.apply(this, arguments);
          };
          srcProto.stop = ours.stop;
        }
      }

      if (contested !== null) {
        ctx.emitFinding({
          kind: KIND,
          reason: 'patch-double-install',
          surfaces: contested,
          detail: 'already patched by another lite-leak kernel instance; both are now ' +
            'active, so graph connections will be double-counted',
        });
      }
    },

    uninstall() {
      if (originals === null) { ctx = null; return; }
      const NodeCtor = target.AudioNode;
      const nodeProto = typeof NodeCtor === 'function' ? NodeCtor.prototype : null;
      const SourceCtor = trackSources ? target.AudioScheduledSourceNode : undefined;
      const srcProto = typeof SourceCtor === 'function' ? SourceCtor.prototype : null;

      let clobbered = null;
      if (nodeProto !== null) {
        for (const prop of ['connect', 'disconnect']) {
          if (typeof originals[prop] !== 'function') continue;
          if (!_restoreIfOurs(nodeProto, prop, ours[prop], originals[prop])) {
            if (clobbered === null) clobbered = [];
            clobbered.push('AudioNode.' + prop);
          }
        }
      }
      if (srcProto !== null) {
        for (const prop of ['start', 'stop']) {
          if (typeof originals[prop] !== 'function') continue;
          if (!_restoreIfOurs(srcProto, prop, ours[prop], originals[prop])) {
            if (clobbered === null) clobbered = [];
            clobbered.push('AudioScheduledSourceNode.' + prop);
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
        for (const c of claimed) _releasePatchSurface(c.obj, c.prop);
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
      if (tag.kind !== 'audio-node') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        // Reaching FR means the node was collected while still registered:
        // disconnect() never ran, because the reap path untracks.
        wasDisconnected: false,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      let dead = null;

      for (const ref of live) {
        const node = ref.deref();
        if (node === undefined) {
          if (dead === null) dead = [];
          dead.push(ref);
          continue;
        }
        const state = states.get(node);
        if (state === undefined || state.reaped) continue;

        if (state.ownerHandle !== undefined && state.ownerHandle !== null) {
          if (nodeId(state.ownerHandle) === undefined) {
            findings.push({
              kind: KIND,
              reason: 'owner-disposed-node-connected',
              origin: state.origin,
            });
          }
        } else {
          findings.push({
            kind: KIND,
            reason: 'no-owner-node-connected',
            origin: state.origin,
          });
        }

        if (trackSources && state.started && !state.stopped) {
          findings.push({
            kind: KIND,
            reason: 'source-started-not-stopped',
            origin: state.origin,
          });
        }
      }

      if (dead !== null) for (let i = 0; i < dead.length; i++) live.delete(dead[i]);
      return findings;
    },

    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'no-owner-connect') {
        return 'An AudioNode was connected to the graph outside any ' +
               'lite-signal owner. A connected node is referenced by the audio ' +
               'graph, so dropping your reference frees nothing. Connect inside ' +
               'an effect() so disconnect() runs on disposal, or tear it down ' +
               'explicitly (@zakkster/lite-audio: call destroy()).';
      }
      if (finding.reason === 'no-owner-node-connected') {
        return 'A node is still wired into the graph with no owner attribution, ' +
               'so nothing will disconnect it. It keeps being rendered for the ' +
               'lifetime of the AudioContext.';
      }
      if (finding.reason === 'owner-disposed-node-connected') {
        return 'A node is still connected although its origin owner was ' +
               'disposed. The auto-disconnect onCleanup did not fire -- check ' +
               'for a broken owner cascade, or a node re-connected after ' +
               'disposal. Disconnect it explicitly.';
      }
      if (finding.reason === 'source-started-not-stopped') {
        return 'A scheduled source was start()ed and never stop()ped. It holds ' +
               'its buffer and keeps rendering until the context closes. Call ' +
               'stop() on the same lifecycle boundary that called start().';
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
