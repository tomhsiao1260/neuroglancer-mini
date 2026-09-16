/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { TypedArrayConstructor } from "#src/util/array.js";

/**
 * If this is updated, DATA_TYPE_BYTES must also be updated.
 */
export enum DataType {
  UINT8 = 0,
  INT8 = 1,
  UINT16 = 2,
  INT16 = 3,
  UINT32 = 4,
  INT32 = 5,
  UINT64 = 6,
  FLOAT32 = 7,
}

export const DATA_TYPE_BYTES: Record<DataType, number> = {
  [DataType.UINT8]: 1,
  [DataType.INT8]: 1,
  [DataType.UINT16]: 2,
  [DataType.INT16]: 2,
  [DataType.UINT32]: 4,
  [DataType.INT32]: 4,
  [DataType.UINT64]: 8,
  [DataType.FLOAT32]: 4,
};

export const DATA_TYPE_ARRAY_CONSTRUCTOR: Record<
  DataType,
  TypedArrayConstructor
> = {
  [DataType.UINT8]: Uint8Array,
  [DataType.INT8]: Int8Array,
  [DataType.UINT16]: Uint16Array,
  [DataType.INT16]: Int16Array,
  [DataType.UINT32]: Uint32Array,
  [DataType.INT32]: Int32Array,
  [DataType.UINT64]: Uint32Array,
  [DataType.FLOAT32]: Float32Array,
};

export const DATA_TYPE_JAVASCRIPT_ELEMENTS_PER_ARRAY_ELEMENT: Record<
  DataType,
  number
> = {
  [DataType.UINT8]: 1,
  [DataType.INT8]: 1,
  [DataType.UINT16]: 1,
  [DataType.INT16]: 1,
  [DataType.UINT32]: 1,
  [DataType.INT32]: 1,
  [DataType.UINT64]: 2,
  [DataType.FLOAT32]: 1,
};

export function makeDataTypeArrayView(
  dataType: DataType,
  buffer: ArrayBuffer,
  byteOffset = 0,
  byteLength: number = buffer.byteLength,
): ArrayBufferView {
  const bytesPerElement = DATA_TYPE_BYTES[dataType];
  const javascriptElementsPerArrayElement =
    DATA_TYPE_JAVASCRIPT_ELEMENTS_PER_ARRAY_ELEMENT[dataType];
  return new DATA_TYPE_ARRAY_CONSTRUCTOR[dataType](
    buffer,
    byteOffset,
    (byteLength / bytesPerElement) * javascriptElementsPerArrayElement,
  );
}
