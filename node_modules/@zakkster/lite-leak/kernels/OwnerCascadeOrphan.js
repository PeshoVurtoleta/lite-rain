/**
 * @zakkster/lite-leak kernel: owner-cascade-orphan
 *
 * Detects tracked handles whose owner-tree ancestors have been disposed
 * (their pool slots recycled or emptied) while the handle itself is still
 * live. This is the "ownership cascade did not fire" bug -- a parent
 * effect disposed, but the child's cleanup path was broken so the child
 * never got its onCleanup callback.
 *
 * Algorithm (per user directive, both at audit-time and at refine-time):
 *   1. Retrieve the handle's stored ownerHandle (only present when track
 *      was called with { audit: true }).
 *   2. Walk upward via ownerOf() and compare against the ownerPath
 *      snapshot frozen at track-time.
 *   3. If any frame is stale (nodeId returns undefined) OR diverged
 *      (id/kind mismatch), the handle is an orphan. Record the depth at
 *      which the divergence occurred (brokenAt).
 *
 * Record contract resilience:
 *   Records with `audit: true` but no capturable owner context
 *   (ownerHandle undefined/null and ownerPath null/empty) are gracefully
 *   handled -- by default returned as null (no finding). Callers who
 *   want the diagnostic signal can pass `{ emitNoAttribution: true }` to
 *   the kernel factory; the kernel then emits a `no-attribution` finding
 *   for audit-opt-in records that lack owner context.
 *
 * Zero global state. No allocations except during the audit walk itself
 * (one descriptor per hop, dropped immediately). Pure library code.
 */

import { ownerOf, nodeId, describe } from '@zakkster/lite-signal';
import { MAX_OWNER_WALK } from '../Leak.js';

const KIND = 'owner-cascade-orphan';
const EMPTY_OPTIONS = Object.freeze(Object.create(null));

/**
 * Inspect one handle+record pair for cascade orphan. Returns a finding
 * object or null if healthy.
 *
 * Record contract: `record` must have `audit`, `ownerPath`, `ownerHandle`,
 * `tag`, `origin`. Any of these can be null/undefined; the function is
 * defensive against every combination. When `audit === true` but no owner
 * context is capturable, returns null by default (caller decides whether
 * to emit a no-attribution finding based on kernel option).
 * @private
 */
function inspect(handle, record) {
  if (!record.audit) return null;
  const snapshot = record.ownerPath;
  const storedOwner = record.ownerHandle;
  // Missing owner context: audit was opted in, but there was no owner at
  // track-time. Caller may choose to emit this as a diagnostic finding.
  const hasSnapshot = snapshot !== null && snapshot !== undefined && snapshot.length > 0;
  const hasStoredOwner = storedOwner !== undefined && storedOwner !== null;
  if (!hasSnapshot || !hasStoredOwner) {
    return { noAttribution: true, tag: record.tag, origin: record.origin, handle: handle };
  }

  // Walk upward from the stored direct owner, checking each level against
  // the frozen snapshot.
  let cursor = storedOwner;
  let depth = 0;
  while (depth < snapshot.length && depth < MAX_OWNER_WALK) {
    const expected = snapshot[depth];
    // Check for staleness: nodeId returns undefined for a stale handle
    // (pool slot recycled or emptied).
    const liveId = nodeId(cursor);
    if (liveId === undefined) {
      return {
        kind: KIND,
        tag: record.tag,
        ownerPath: snapshot,
        origin: record.origin,
        brokenAt: depth,
        reason: 'stale',
        handle: handle,
      };
    }
    if (liveId !== expected.id) {
      // Same slot, different resident -- a divergence.
      const liveDesc = describe(cursor);
      return {
        kind: KIND,
        tag: record.tag,
        ownerPath: snapshot,
        origin: record.origin,
        brokenAt: depth,
        reason: 'diverged',
        liveFrame: liveDesc !== undefined
          ? { id: liveDesc.id, kind: liveDesc.kind }
          : null,
        handle: handle,
      };
    }
    // Kind mismatch (unusual: same id, different kind is engine-impossible
    // in practice but we guard for it).
    const liveDesc = describe(cursor);
    if (liveDesc !== undefined && liveDesc.kind !== expected.kind) {
      return {
        kind: KIND,
        tag: record.tag,
        ownerPath: snapshot,
        origin: record.origin,
        brokenAt: depth,
        reason: 'kind-diverged',
        liveFrame: { id: liveDesc.id, kind: liveDesc.kind },
        handle: handle,
      };
    }
    // Advance upward. ownerOf returns a fresh descriptor (allocation);
    // we drop the previous cursor before overwriting.
    cursor = ownerOf(cursor);
    depth++;
    if (cursor === undefined && depth < snapshot.length) {
      // Ran out of owners before reaching the snapshot's root -- the tree
      // was truncated somewhere. That is also an orphan signal.
      return {
        kind: KIND,
        tag: record.tag,
        ownerPath: snapshot,
        origin: record.origin,
        brokenAt: depth,
        reason: 'truncated',
        handle: handle,
      };
    }
  }
  return null;
}

/**
 * Create the owner-cascade-orphan kernel. The kernel is stateless and
 * patches no globals; safe to register/unregister freely.
 *
 * @param {object} [options]
 * @param {boolean} [options.emitNoAttribution=false]
 *   When true, records tracked with `{ audit: true }` but no capturable
 *   owner context (top-level, createRoot, or track(null, null, null,
 *   { audit: true })) produce a `no-attribution` finding at audit time and
 *   a `no-attribution` refine at FR time. Default false preserves the
 *   original silent-skip behavior.
 * @param {number} [options.priority=0]
 */
export function createOwnerCascadeOrphanKernel(options) {
  const opts = options || EMPTY_OPTIONS;
  const emitNoAttribution = opts.emitNoAttribution === true;
  const priority = typeof opts.priority === 'number' ? opts.priority : 0;
  let ctx = null;

  function classify(handle, record) {
    const finding = inspect(handle, record);
    if (finding === null) return null;
    if (finding.noAttribution === true) {
      if (!emitNoAttribution) return null;
      return {
        kind: KIND,
        reason: 'no-attribution',
        tag: finding.tag,
        ownerPath: null,
        origin: finding.origin,
        handle: finding.handle,
      };
    }
    return finding;
  }

  return {
    name: 'owner-cascade-orphan',
    patchSurfaces: [],
    priority: priority,

    install(kernelCtx) {
      ctx = kernelCtx;
    },

    uninstall() {
      ctx = null;
    },

    /**
     * FR-time refinement: called when a tracked target was collected.
     */
    refine(report, leakRecord) {
      if (!leakRecord.audit) return null;
      const finding = classify(leakRecord.handle, leakRecord);
      if (finding === null) return null;
      if (finding.reason === 'no-attribution') {
        return {
          tag: report.tag,
          ownerPath: report.ownerPath,
          origin: report.origin,
          kind: KIND,
          collectedAt: report.collectedAt,
          reason: 'no-attribution',
        };
      }
      return {
        tag: report.tag,
        ownerPath: report.ownerPath,
        origin: report.origin,
        kind: KIND,
        collectedAt: report.collectedAt,
        brokenAt: finding.brokenAt,
        reason: finding.reason,
        liveFrame: finding.liveFrame !== undefined ? finding.liveFrame : null,
      };
    },

    /**
     * On-demand audit: walk every audited handle and check its owner chain.
     */
    audit() {
      if (ctx === null) return [];
      const findings = [];
      ctx.forEachAuditedHandle(function (handle, record) {
        const finding = classify(handle, record);
        if (finding !== null) findings.push(finding);
      });
      return findings;
    },

    /**
     * Advisory generator for tracker.remediate().
     */
    advise(finding) {
      if (finding === null || finding.kind !== KIND) return null;
      if (finding.reason === 'stale') {
        return 'The owner at depth ' + finding.brokenAt + ' has been disposed ' +
               '(its pool slot recycled), but the tracked handle survives. ' +
               'This suggests the dispose cascade missed a child -- check ' +
               'for a broken onCleanup chain or a manually-managed handle ' +
               'that was not paired with untrack().';
      }
      if (finding.reason === 'diverged') {
        return 'The owner at depth ' + finding.brokenAt + ' has a different ' +
               'identity than at track-time (slot was recycled and reassigned). ' +
               'The tracked handle is orphaned from its original owner tree.';
      }
      if (finding.reason === 'kind-diverged') {
        return 'The owner at depth ' + finding.brokenAt + ' changed kind since ' +
               'track-time -- an engine-anomalous state suggesting mid-flight ' +
               'graph mutation.';
      }
      if (finding.reason === 'truncated') {
        return 'The live owner chain is shorter than the snapshot at track-time. ' +
               'One or more ancestors were disposed without the leaf being ' +
               'untracked.';
      }
      if (finding.reason === 'no-attribution') {
        return 'A handle was tracked with { audit: true } but had no capturable ' +
               'owner context (top-level, createRoot, or synthetic null-record ' +
               'shape). The kernel cannot verify cascade correctness for this ' +
               'handle. If the handle was intended to be owner-scoped, wrap ' +
               'the track() call in an effect() body; if it was intended to ' +
               'live at top-level, this finding can be silenced by omitting ' +
               '`emitNoAttribution` from the kernel options.';
      }
      return null;
    },
  };
}
