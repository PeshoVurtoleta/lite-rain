// Explain mode, node-only half: heap allocation sampling via node:inspector.
//
// This lives in its own file for one reason. `Explain.js` documents its
// formatters as runnable "in a failed CI job or a browser", but it opened with
// a STATIC `import { Session } from 'node:inspector'`, and a static import of a
// node builtin makes the whole module unloadable in a browser -- the four pure
// formatters included. A browser demo importing the subpath got
// `GET node:inspector net::ERR_FAILED` before a single formatter ran.
//
// ESM cannot conditionally static-import, and startExplainSampling is
// synchronous by contract (six call sites, and ExplainHandle is declared as a
// value, not a promise), so a dynamic import would have been a breaking change.
// A file split plus a `browser` export condition keeps the signature and makes
// the formatters load anywhere.

import { Session } from 'node:inspector';

const DEFAULT_INTERVAL_BYTES = 512 * 1024;                  // 512 KB sampling interval

/**
 * Start heap allocation sampling. Returns a handle with .stop() that yields
 * top allocation stacks.
 *
 * @param {{ intervalBytes?: number, topN?: number }} [options]
 *   intervalBytes: bytes between samples (default 512 KB). Smaller = more
 *                  detail, more perturbation.
 *   topN:          how many top stacks to include in the report (default 10).
 * @returns {ExplainHandle}
 */
function startExplainSampling(options) {
    const opts = options || {};
    const intervalBytes = opts.intervalBytes > 0 ? opts.intervalBytes : DEFAULT_INTERVAL_BYTES;
    const topN = opts.topN > 0 ? opts.topN : 10;

    const session = new Session();
    session.connect();

    // Wrap the callback-shaped inspector API in a Promise for ergonomic use.
    function post(method, params) {
        return new Promise((resolve, reject) => {
            session.post(method, params, (err, result) => {
                if (err) reject(err); else resolve(result);
            });
        });
    }

    let started = false;
    let stopped = false;

    const startPromise = post('HeapProfiler.startSampling', {
        samplingInterval: intervalBytes
    }).then(() => { started = true; });

    return {
        started: startPromise,
        /**
         * Stop sampling and return top allocation stacks.
         * @returns {Promise<{ topStacks: Array<{ selfSize: number, functionName: string, url: string, lineNumber: number }>, samplingInterval: number, topN: number }>}
         */
        stop() {
            if (stopped) return Promise.resolve({ topStacks: [], samplingInterval: intervalBytes, topN, error: 'already stopped' });
            stopped = true;
            return startPromise.then(() => {
                if (!started) return { topStacks: [], samplingInterval: intervalBytes, topN, error: 'never started' };
                return post('HeapProfiler.stopSampling').then((res) => {
                    session.disconnect();
                    return { topStacks: _extractTopStacks(res.profile, topN), samplingInterval: intervalBytes, topN };
                });
            });
        }
    };
}

// Walk the sampling profile's node tree, sum selfSize per node, sort, return
// top N with call-site info. The profile is a tree of {callFrame, selfSize,
// children[]}; selfSize is bytes allocated at this frame directly.

function _extractTopStacks(profile, topN) {
    const flat = [];
    function visit(node) {
        if (node.selfSize > 0) {
            const cf = node.callFrame || {};
            flat.push({
                selfSize: node.selfSize,
                functionName: cf.functionName || '(anonymous)',
                url: cf.url || '(unknown)',
                lineNumber: cf.lineNumber || 0,
                columnNumber: cf.columnNumber || 0
            });
        }
        if (node.children) for (const c of node.children) visit(c);
    }
    visit(profile.head);
    flat.sort((a, b) => b.selfSize - a.selfSize);
    return flat.slice(0, topN);
}

export { startExplainSampling };
