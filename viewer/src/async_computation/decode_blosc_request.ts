/** @license Copyright 2023 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import { asyncComputation } from "#src/async_computation/index.js";

// Decompresses a blosc buffer (see `decode_blosc.ts`, which runs in the pool worker).  Kept apart from
// the implementation so that requesting it does not load the decompressor into the chunk worker.
export const decodeBlosc =
  asyncComputation<(data: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>>(
    "decodeBlosc",
  );
