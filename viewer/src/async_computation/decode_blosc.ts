/** @license Copyright 2023 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import Blosc from "numcodecs/blosc";
import { decodeBlosc } from "#src/async_computation/decode_blosc_request.js";
import { registerAsyncComputation } from "#src/async_computation/handler.js";

// The blosc header stores the compressor, shuffle and type size, so decoding needs no
// configuration.
const codec = Blosc.fromConfig({ id: "blosc" });

registerAsyncComputation(decodeBlosc, async (data) => {
  const result = (await codec.decode(data)) as Uint8Array<ArrayBuffer>;
  return { value: result, transfer: [result.buffer] };
});
