// Entry point of the pool workers that run async computations (see
// `src/async_computation/index.ts`).
//
// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
import "#src/async_computation/decode_blosc.js";
import "#src/async_computation/handler.js";
