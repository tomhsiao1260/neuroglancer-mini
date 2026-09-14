/**
 * @license
 * Copyright 2023 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Blosc from "numcodecs/blosc";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";
import { convertEndian } from "#src/util/endian.js";

// The blosc header stores the compressor, shuffle and type size, so decoding needs no
// configuration.
const blosc = Blosc.fromConfig({ id: "blosc" });

/**
 * Decodes the contents of a chunk file into the chunk's voxel values: decompresses them if the
 * array is compressed, then views the bytes as the array's data type in native byte order.  Voxels
 * are in C order, i.e. x varies fastest.
 */
export async function decodeChunk(
  metadata: ArrayMetadata,
  encoded: Uint8Array,
): Promise<ArrayBufferView> {
  if (metadata.compressor === "blosc") {
    encoded = await blosc.decode(encoded);
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
  const data = makeDataTypeArrayView(
    dataType,
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  convertEndian(data, metadata.endianness, bytesPerElement);
  return data;
}
