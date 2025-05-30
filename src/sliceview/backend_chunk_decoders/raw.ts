/**
 * @license
 * Copyright 2016 Google Inc.
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

import { postProcessRawData } from "#src/sliceview/backend_chunk_decoders/postprocess.js";
import type { VolumeChunk } from "#src/sliceview/volume/backend.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { DATA_TYPE_BYTES, makeDataTypeArrayView } from "#src/util/data_type.js";
import type { Endianness } from "#src/util/endian.js";
import { convertEndian, ENDIANNESS } from "#src/util/endian.js";
import * as vector from "#src/util/vector.js";

export async function decodeRawChunk(
  chunk: VolumeChunk,
  cancellationToken: CancellationToken,
  response: ArrayBuffer,
  endianness: Endianness = ENDIANNESS,
) {
  cancellationToken;
  const { spec } = chunk.source!;
  const { dataType } = spec;
  const numElements = vector.prod(chunk.chunkDataSize!);
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  const expectedBytes = numElements * bytesPerElement;
  if (expectedBytes !== response.byteLength) {
    throw new Error(
      `Raw-format chunk is ${response.byteLength} bytes, ` +
        `but ${numElements} * ${bytesPerElement} = ${expectedBytes} bytes are expected.`,
    );
  }
  const data = makeDataTypeArrayView(dataType, response);
  if (endianness !== ENDIANNESS) {
    convertEndian(data, bytesPerElement, endianness);
  }
  await postProcessRawData(chunk, cancellationToken, data);
}
