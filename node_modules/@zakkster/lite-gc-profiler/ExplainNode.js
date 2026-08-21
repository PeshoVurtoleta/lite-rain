// Node entry for the ./explain subpath: the browser-safe formatters plus the
// inspector-backed sampler. The export map routes browsers to Explain.js
// alone, so `startExplainSampling` is simply absent there rather than
// breaking the module load for everything else.

export * from './Explain.js';
export { startExplainSampling } from './ExplainSampling.js';
