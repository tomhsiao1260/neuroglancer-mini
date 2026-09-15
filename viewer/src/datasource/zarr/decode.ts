/** @license Copyright 2023 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import { decodeBlosc } from "#src/async_computation/decode_blosc_request.js";
import { requestAsyncComputation } from "#src/async_computation/request.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";

/**
 * Decodes the contents of a chunk file into the chunk's voxel values: decompresses them if the
 * array is compressed, then views the bytes as the array's data type.  The values are
 * little-endian, which is also the byte order of the platforms browsers run on, so no conversion is
 * needed.  Voxels are in C order, i.e. x varies fastest.
 *
 * Decompression runs in a pool worker (see `async_computation/`), which takes over `encoded`.
 */
export async function decodeChunk(
  metadata: ArrayMetadata,
  encoded: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<ArrayBufferView> {
  if (metadata.compressor === "blosc") {
    encoded = await requestAsyncComputation(
      decodeBlosc,
      signal,
      [encoded.buffer],
      encoded,
    );
  }
  const { dataType, chunkShape } = metadata;
  const numElements = chunkShape.reduce((a, b) => a * b, 1);
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  const expectedBytes = numElements * bytesPerElement;
  if (encoded.byteLength !== expectedBytes) {
    throw new Error(
      `Raw-format chunk is ${encoded.byteLength} bytes, ` +
        `but ${numElements} * ${bytesPerElement} = ${expectedBytes} bytes are expected.`,
    );
  }
  return makeDataTypeArrayView(
    dataType,
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
}
