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

import { parseCodecChainSpec } from "#src/datasource/zarr/codec/resolve.js";
import type {
  DimensionSeparator,
  Metadata,
  NodeType,
} from "#src/datasource/zarr/metadata/index.js";
import { ChunkKeyEncoding } from "#src/datasource/zarr/metadata/index.js";
import { parseNameAndConfiguration } from "#src/datasource/zarr/metadata/parse_util.js";
import { DataType } from "#src/util/data_type.js";
import { Endianness } from "#src/util/endian.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyConstant,
  verifyEnumString,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalFixedLengthArrayOfStringOrNull,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";
import { parseNumpyDtype } from "#src/util/numpy_dtype.js";
import { allSiPrefixes } from "#src/util/si_units.js";

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

export function parseChunkShape(obj: unknown, rank: number): number[] {
  return parseFixedLengthArray(new Array<number>(rank), obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) {
      throw new Error(
        `Expected positive integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

export function parseDimensionSeparator(value: unknown): "/" | "." {
  if (value !== "." && value !== "/") {
    throw new Error(
      `Expected "." or "/", but received: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const UNITS = new Map<string, { unit: string; scale: number }>([
  ["", { unit: "", scale: 1 }],
  ["angstrom", { unit: "m", scale: 1e-10 }],
  ["foot", { unit: "m", scale: 0.3048 }],
  ["inch", { unit: "m", scale: 0.0254 }],
  ["mile", { unit: "m", scale: 1609.34 }],
  // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
  ["parsec", { unit: "m", scale: 3.0856775814913673e16 }],
  ["yard", { unit: "m", scale: 0.9144 }],
  ["minute", { unit: "s", scale: 60 }],
  ["hour", { unit: "s", scale: 60 * 60 }],
  ["day", { unit: "s", scale: 60 * 60 * 24 }],
]);

for (const unit of ["meter", "second"]) {
  for (const siPrefix of allSiPrefixes) {
    const { longPrefix, prefix } = siPrefix;
    if (longPrefix === undefined) continue;
    const unitInfo = { unit: unit[0], scale: 10 ** siPrefix.exponent };
    UNITS.set(`${longPrefix}${unit}`, unitInfo);
    UNITS.set(`${prefix}${unit[0]}`, unitInfo);
  }
}

export function parseDimensionUnit(obj: unknown): {
  scale: number;
  unit: string;
} {
  if (obj === null) {
    // Default unit
    return { scale: 1, unit: "" };
  }
  if (typeof obj !== "string") {
    throw new Error(`Expected string but received: ${JSON.stringify(obj)}`);
  }
  const s = obj.trim();
  const numberPattern =
    /^([-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?\d+)?)\s*(.*)/;
  const m = s.match(numberPattern);
  let scale: number;
  let derivedUnit: string;
  if (m === null) {
    scale = 1;
    derivedUnit = s;
  } else {
    scale = Number(m[1]);
    derivedUnit = m[2];
  }
  const unitInfo = UNITS.get(derivedUnit);
  if (unitInfo === undefined) {
    throw new Error(`Unsupported unit: ${JSON.stringify(derivedUnit)}`);
  }
  return { unit: unitInfo.unit, scale: scale * unitInfo.scale };
}

export function parseV2Metadata(obj: unknown): any {
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
    const order = verifyObjectProperty(obj, "order", (order) => {
      if (order !== "C" && order !== "F") {
        throw new Error(
          `Expected "C" or "F", but received: ${JSON.stringify(order)}`,
        );
      }
      return order;
    });
    const dimensionSeparator: DimensionSeparator = verifyOptionalObjectProperty(
      obj,
      "dimension_separator",
      parseDimensionSeparator,
    );
    const numpyDtype = verifyObjectProperty(obj, "dtype", (dtype) =>
      parseNumpyDtype(verifyString(dtype)),
    );

    const dataType = numpyDtype.dataType;

    const codecs = [];
    if (order === "F") {
      codecs.push({
        name: "transpose",
        configuration: { order: Array.from(shape, (_, i) => rank - i - 1) },
      });
    }
    codecs.push({
      name: "bytes",
      configuration: {
        endian: numpyDtype.endianness === Endianness.LITTLE ? "little" : "big",
      },
    });
    verifyObjectProperty(obj, "compressor", (compressor) => {
      if (compressor === null) return;
      verifyObject(compressor);
      const id = verifyObjectProperty(compressor, "id", verifyString);
      switch (id) {
        case "blosc":
          codecs.push({ name: "blosc", configuration: compressor });
          break;
        default:
          throw new Error(`Unsupported compressor: ${JSON.stringify(id)}`);
      }
    });

    const codecChainSpec = parseCodecChainSpec(codecs, {
      dataType,
      chunkShape,
    });

    return {
      zarrVersion: 2,
      nodeType: "array",
      rank,
      shape,
      chunkShape,
      dataType,
      dimensionSeparator,
      codecs: codecChainSpec,
    };
  } catch (e) {
    throw new Error(`Error parsing zarr v2 metadata: ${e.message}`);
  }
}
