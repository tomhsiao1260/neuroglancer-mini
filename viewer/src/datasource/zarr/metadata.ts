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

import type { DataType } from "#src/util/data_type.js";
import type { Endianness } from "#src/util/endian.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyConstant,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { parseNumpyDtype } from "#src/util/numpy_dtype.js";

export type DimensionSeparator = "/" | ".";

/**
 * The parts of a zarr v2 `.zarray` file needed to read and decode chunks.
 */
export interface ArrayMetadata {
  rank: number;
  // Array shape in voxels, in (z, y, x) order.
  shape: number[];
  // Chunk shape in voxels, in (z, y, x) order.
  chunkShape: number[];
  dataType: DataType;
  endianness: Endianness;
  // Compression of each chunk file; `null` means chunks are stored uncompressed.
  compressor: "blosc" | null;
  // Separator between the chunk indices of a chunk key, e.g. `52/24/18`.
  dimensionSeparator: DimensionSeparator;
}

function parseShape(obj: unknown): number[] {
  return parseArray(obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) {
      throw new Error(
        `Expected non-negative integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

function parseChunkShape(obj: unknown, rank: number): number[] {
  return parseFixedLengthArray(new Array<number>(rank), obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) {
      throw new Error(
        `Expected positive integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

function parseDimensionSeparator(value: unknown): DimensionSeparator {
  if (value !== "." && value !== "/") {
    throw new Error(
      `Expected "." or "/", but received: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function parseV2Metadata(obj: unknown): ArrayMetadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, "zarr_format", (value) => {
      verifyConstant(value, 2);
    });
    const shape = verifyObjectProperty(obj, "shape", parseShape);
    const rank = shape.length;
    const chunkShape = verifyObjectProperty(obj, "chunks", (chunks) =>
      parseChunkShape(chunks, rank),
    );
    verifyObjectProperty(obj, "order", (order) => {
      // Fortran order would need the chunk data transposed, which is not supported.
      if (order !== "C") {
        throw new Error(
          `Expected "C", but received: ${JSON.stringify(order)}`,
        );
      }
    });
    const dimensionSeparator = verifyOptionalObjectProperty(
      obj,
      "dimension_separator",
      parseDimensionSeparator,
      ".",
    );
    const { dataType, endianness } = verifyObjectProperty(
      obj,
      "dtype",
      (dtype) => parseNumpyDtype(verifyString(dtype)),
    );
    const compressor = verifyObjectProperty(obj, "compressor", (value) => {
      if (value === null) return null;
      verifyObject(value);
      const id = verifyObjectProperty(value, "id", verifyString);
      if (id !== "blosc") {
        throw new Error(`Unsupported compressor: ${JSON.stringify(id)}`);
      }
      return id;
    });
    return {
      rank,
      shape,
      chunkShape,
      dataType,
      endianness,
      compressor,
      dimensionSeparator,
    };
  } catch (e) {
    throw new Error(`Error parsing zarr v2 metadata: ${(e as Error).message}`);
  }
}
