// v1.0.0 back-compat shim.
//
// The main file was renamed to Gc.js in v1.1.0 to match the ecosystem
// PascalCase convention. This shim preserves any code that imported from
// './index.js' -- pre-existing tests in this repo, and any downstream
// consumer that hard-coded a relative path.
//
// Everything is re-exported from Gc.js unchanged; there is no divergence
// between what './index.js' and './Gc.js' expose. Prefer './Gc.js' in new
// code.

export * from './Gc.js';
