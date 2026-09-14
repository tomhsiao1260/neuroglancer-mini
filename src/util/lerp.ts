/**
 * @license
 * Copyright 2021 Google Inc.
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

import { DataType } from "#src/util/data_type.js";
import { nextAfterFloat64 } from "#src/util/float.js";
import { parseFixedLengthArray } from "#src/util/json.js";
import { Uint64 } from "#src/util/uint64.js";

export type DataTypeInterval = [number, number] | [Uint64, Uint64];

export type UnknownDataTypeInterval = [number | Uint64, number | Uint64];

export const defaultDataTypeRange: Record<DataType, DataTypeInterval> = {
  [DataType.UINT8]: [0, 0xff],
  [DataType.INT8]: [-0x80, 0x7f],
  [DataType.UINT16]: [0, 0xffff],
  [DataType.INT16]: [-0x8000, 0x7fff],
  [DataType.UINT32]: [0, 0xffffffff],
  [DataType.INT32]: [-0x80000000, 0x7fffffff],
  [DataType.UINT64]: [Uint64.ZERO, new Uint64(0xffffffff, 0xffffffff)],
  [DataType.FLOAT32]: [0, 1],
};

export function clampToInterval(
  range: DataTypeInterval,
  value: number | Uint64,
): number | Uint64 {
  if (typeof value === "number") {
    return Math.min(Math.max(range[0] as number, value), range[1] as number);
  }
  return Uint64.min(Uint64.max(range[0] as Uint64, value), range[1] as Uint64);
}

// Validates that the lower bound is <= the upper bound.
export function validateDataTypeInterval(
  interval: DataTypeInterval,
): DataTypeInterval {
  if (dataTypeCompare(interval[0], interval[1]) <= 0) return interval;
  throw new Error(`Invalid interval: [${interval[0]}, ${interval[1]}]`);
}

// Ensures the lower bound is <= the upper bound.
export function normalizeDataTypeInterval(
  interval: DataTypeInterval,
): DataTypeInterval {
  if (dataTypeCompare(interval[0], interval[1]) <= 0) return interval;
  return [interval[1], interval[0]] as DataTypeInterval;
}

export function dataTypeCompare(a: number | Uint64, b: number | Uint64) {
  if (typeof a === "number") {
    return (a as number) - (b as number);
  }
  return Uint64.compare(a as Uint64, b as Uint64);
}

const tempUint64 = new Uint64();
const temp2Uint64 = new Uint64();

export function parseDataTypeValue(
  dataType: DataType,
  x: unknown,
): number | Uint64 {
  let s: string;
  if (typeof x !== "string") {
    s = "" + x;
  } else {
    s = x;
  }
  switch (dataType) {
    case DataType.UINT64:
      return Uint64.parseString(s);
    case DataType.FLOAT32: {
      const value = parseFloat(s);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid float32 value: ${JSON.stringify(s)}`);
      }
      return value;
    }
    default: {
      const value = parseInt(s);
      const dataTypeRange = defaultDataTypeRange[dataType];
      if (
        !Number.isInteger(value) ||
        value < (dataTypeRange[0] as number) ||
        value > (dataTypeRange[1] as number)
      ) {
        throw new Error(
          `Invalid ${DataType[dataType].toLowerCase()} value: ${JSON.stringify(
            s,
          )}`,
        );
      }
      return value;
    }
  }
}

export function parseUnknownDataTypeValue(x: unknown): number | Uint64 {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const num64 = new Uint64();
    const num = Number(x);
    if (num64.tryParseString(x)) {
      if (num.toString() === num64.toString()) {
        return num;
      }
      return num64;
    }
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid value: ${JSON.stringify(x)}`);
    }
    return num;
  }
  throw new Error(`Invalid value: ${JSON.stringify(x)}`);
}

export function parseDataTypeInterval(
  obj: unknown,
  dataType: DataType,
): DataTypeInterval {
  return parseFixedLengthArray(new Array(2), obj, (x) =>
    parseDataTypeValue(dataType, x),
  ) as DataTypeInterval;
}

export function parseUnknownDataTypeInterval(
  obj: unknown,
): UnknownDataTypeInterval {
  return parseFixedLengthArray(new Array(2), obj, (x) =>
    parseUnknownDataTypeValue(x),
  ) as UnknownDataTypeInterval;
}

export function dataTypeIntervalEqual(
  dataType: DataType,
  a: DataTypeInterval,
  b: DataTypeInterval,
) {
  if (dataType === DataType.UINT64) {
    return (
      Uint64.equal(a[0] as Uint64, b[0] as Uint64) &&
      Uint64.equal(a[1] as Uint64, b[1] as Uint64)
    );
  }
  return a[0] === b[0] && a[1] === b[1];
}

export function dataTypeIntervalToJson(
  range: DataTypeInterval,
  dataType: DataType,
  defaultRange = defaultDataTypeRange[dataType],
) {
  if (dataTypeIntervalEqual(dataType, range, defaultRange)) return undefined;
  if (dataType === DataType.UINT64) {
    return [range[0].toString(), range[1].toString()];
  }
  return range;
}

export function convertDataTypeInterval(
  interval: UnknownDataTypeInterval | undefined,
  dataType: DataType,
): DataTypeInterval {
  if (interval === undefined) {
    return defaultDataTypeRange[dataType];
  }
  let [lower, upper] = interval;
  if (dataType === DataType.UINT64) {
    if (typeof lower === "number") {
      lower = Uint64.fromNumber(lower);
    }
    if (typeof upper === "number") {
      upper = Uint64.fromNumber(upper);
    }
    return [lower, upper];
  }
  // Ensure that neither lower nor upper is a `Uint64`.
  if (typeof lower !== "number") {
    lower = lower.toNumber();
  }
  if (typeof upper !== "number") {
    upper = upper.toNumber();
  }
  if (dataType !== DataType.FLOAT32) {
    lower = Math.round(lower);
    upper = Math.round(upper);
    const range = defaultDataTypeRange[dataType] as [number, number];
    if (!Number.isFinite(lower)) {
      lower = range[0];
    } else {
      lower = Math.min(Math.max(range[0], lower), range[1]);
    }
    if (!Number.isFinite(upper)) {
      upper = range[1];
    } else {
      upper = Math.min(Math.max(range[0], upper), range[1]);
    }
  }
  return [lower, upper];
}
