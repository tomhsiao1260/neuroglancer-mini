/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Support for parsing NumPy dtype strings.
 */

import { DataType } from "#src/util/data_type.js";
import { Endianness } from "#src/util/endian.js";

export interface NumpyDtype {
  dataType: DataType;
  endianness: Endianness;
}

const supportedDataTypes = new Map<string, NumpyDtype>();
supportedDataTypes.set("|u1", {
  endianness: Endianness.LITTLE,
  dataType: DataType.UINT8,
});
supportedDataTypes.set("|i1", {
  endianness: Endianness.LITTLE,
  dataType: DataType.INT8,
});
for (const [endiannessChar, endianness] of <[string, Endianness][]>[
  ["<", Endianness.LITTLE],
  [">", Endianness.BIG],
]) {
  // For now, treat both signed and unsigned integer types as unsigned.
  for (const typeChar of ["u", "i"]) {
    supportedDataTypes.set(`${endiannessChar}${typeChar}8`, {
      endianness,
      dataType: DataType.UINT64,
    });
  }
  supportedDataTypes.set(`${endiannessChar}u2`, {
    endianness,
    dataType: DataType.UINT16,
  });

  supportedDataTypes.set(`${endiannessChar}i2`, {
    endianness,
    dataType: DataType.INT16,
  });

  supportedDataTypes.set(`${endiannessChar}u4`, {
    endianness,
    dataType: DataType.UINT32,
  });

  supportedDataTypes.set(`${endiannessChar}i4`, {
    endianness,
    dataType: DataType.INT32,
  });

  supportedDataTypes.set(`${endiannessChar}f4`, {
    endianness,
    dataType: DataType.FLOAT32,
  });
}

export function parseNumpyDtype(typestr: unknown): NumpyDtype {
  const dtype = supportedDataTypes.get(typestr as any);
  if (dtype === undefined) {
    throw new Error(`Unsupported numpy data type: ${JSON.stringify(typestr)}`);
  }
  return dtype;
}
