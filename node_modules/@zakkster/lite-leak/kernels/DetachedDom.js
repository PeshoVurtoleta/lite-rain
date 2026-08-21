/**
 * @zakkster/lite-leak kernel: detached-dom
 *
 * Detects DOM nodes that have been detached from the tree but were never
 * explicitly untracked -- a common pattern where a component removes a
 * subtree from the DOM but a closure elsewhere (event handler, cache,
 * signal subscriber) retains one of the detached nodes.
 *
 * Unlike the other kernels, detached-dom does not patch a global; users
 * opt in per-node via `kernel.watch(node, tag?)`. That returns a lite-leak
 * handle so untrack can be called explicitly. The kernel maintains a
 * MutationObserver on the configured root to catch removals live; audit
 * scans `node.isConnected` on all watched nodes.
 *
 * Patch surface claimed: 'detached-dom.root' (per-root uniqueness).
 */

import { getOwner, onCleanup } from '@zakkster/lite-signal';

const KIND = 'detached-dom';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

/**
 * Create the detached-dom kernel.
 *
 * @param {object} [options]
 * @param {Node} [options.root=document]
 *   Root node whose subtree is observed for removals. Default is the
 *   document (top-level).
 * @param {boolean} [options.warnOnDetach=true]
 *   Emit `onWarning` live when a watched node is removed from the tree
 *   without a prior explicit untrack.
 * @param {boolean} [options.captureStacks=false]
 * @param {number} [options.priority=0]
 */
export function createDetachedDomKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const root = opts.root || (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
  const warnOnDetach = opts.warnOnDetach !== false;
  const captureStacks = opts.captureStacks === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;
  const MutObs = typeof globalThis.MutationObserver === 'function' ? globalThis.MutationObserver : null;

  let ctx = null;
  // node -> state (strong ref; watched nodes are expected to be user-anchored
  // via `watch()` return handle, so retention here is the user's opt-in cost).
  const watched = new Map();
  let observer = null;

  function handleMutations(records) {
    if (ctx === null) return;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.type !== 'childList') continue;
      const removed = rec.removedNodes;
      for (let j = 0; j < removed.length; j++) {
        checkSubtree(removed[j]);
      }
    }
  }

  function checkSubtree(node) {
    // Fast path: this node itself.
    if (watched.has(node)) reportDetach(node);
    // Walk descendants via TreeWalker-equivalent recursion (jsdom & browsers
    // both support childNodes; small subtrees only).
    if (typeof node.childNodes !== 'undefined') {
      for (let i = 0; i < node.childNodes.length; i++) {
        checkSubtree(node.childNodes[i]);
      }
    }
  }

  function reportDetach(node) {
    const state = watched.get(node);
    if (state === undefined) return;
    // Only report once per watched node -- consumer must untrack or re-watch
    // if they want another signal.
    watched.delete(node);
    if (ctx !== null) ctx.untrack(state.handle);
    if (warnOnDetach && ctx !== null) {
      ctx.emitWarning({
        kind: KIND,
        reason: 'detached-without-untrack',
        tag: state.tag,
        origin: state.origin,
      });
    }
  }

  const kernel = {
    name: 'detached-dom',
    patchSurfaces: ['detached-dom.root'],
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
      if (root !== null && MutObs !== null) {
        observer = new MutObs(handleMutations);
        observer.observe(root, { childList: true, subtree: true });
      }
    },

    uninstall() {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      watched.clear();
      ctx = null;
    },

    /**
     * Watch a DOM node. Returns a lite-leak handle -- call `tracker.untrack(handle)`
     * (or let the enclosing owner disposal cascade untrack) when done.
     *
     * @param {Node} node
     * @param {unknown} [tag]
     */
    watch(node, tag) {
      if (ctx === null) throw new Error('detached-dom: watch() called before install');
      const ownerHandle = getOwner();
      const origin = captureStacks ? new Error().stack : null;
      const handle = ctx.track(node, function () {}, {
        kind: 'dom-node',
        tag: tag === undefined ? null : tag,
      }, { audit: true });
      const state = {
        node: node,
        tag: tag === undefined ? null : tag,
        origin: origin,
        handle: handle,
      };
      watched.set(node, state);
      if (ownerHandle !== undefined) {
        onCleanup(function () {
          if (watched.has(node)) watched.delete(node);
        });
      }
      return handle;
    },

    refine(report, leakRecord) {
      const tag = leakRecord.tag;
      if (tag === null || typeof tag !== 'object') return null;
      if (tag.kind !== 'dom-node') return null;
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        userTag: tag.tag,
      };
    },

    audit() {
      if (ctx === null) return [];
      const findings = [];
      const toReap = [];
      for (const [node, state] of watched) {
        // Reap disposed handles lazily.
        if (state.handle.disposed === true) {
          toReap.push(node);
          continue;
        }
        // Node has been detached from the tree without going through
        // MutationObserver (e.g. root was set to a different subtree, or
        // node was removed before MutationObserver was armed).
        if (typeof node.isConnected === 'boolean' && node.isConnected === false) {
          findings.push({
            kind: KIND,
            reason: 'detached-at-audit',
            tag: state.tag,
            origin: state.origin,
          });
        }
      }
      for (let i = 0; i < toReap.length; i++) watched.delete(toReap[i]);
      return findings;
    },

    /**
     * Live resources this kernel is watching. Part of the public kernel
     * contract as of 1.6.0: snapshot() reads it, and a kernel that cannot
     * answer omits it so the count reads null rather than zero.
     */
    count: function () { return watched.size; },

    _watchedCount() { return watched.size; },
  };

  return kernel;
}
