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

export interface WritableArrayLike<T> {
  length: number;
  [n: number]: T;
}

export type TypedArrayConstructor =
  | typeof Int8Array
  | typeof Uint8Array
  | typeof Int16Array
  | typeof Uint16Array
  | typeof Int32Array
  | typeof Uint32Array
  | typeof Float32Array
  | typeof Float64Array;

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

/**
 * Returns an array of size newSize that starts with the contents of array.
 * Either returns array if it has the correct size, or a new array with zero
 * padding at the end.
 */
export function maybePadArray<T extends TypedArray>(
  array: T,
  newSize: number,
): T {
  if (array.length === newSize) {
    return array;
  }
  const newArray = new (<any>array.constructor)(newSize);
  newArray.set(array);
  return newArray;
}

export function tile2dArray<T extends TypedArray>(
  array: T,
  majorDimension: number,
  minorTiles: number,
  majorTiles: number,
) {
  const minorDimension = array.length / majorDimension;
  const length = array.length * minorTiles * majorTiles;
  const result: T = new (<any>array.constructor)(length);
  const minorTileStride = array.length * majorTiles;
  const majorTileStride = majorDimension;
  const minorStride = majorDimension * majorTiles;
  for (let minor = 0; minor < minorDimension; ++minor) {
    for (let major = 0; major < majorDimension; ++major) {
      const inputValue = array[minor * majorDimension + major];
      const baseOffset = minor * minorStride + major;
      for (let minorTile = 0; minorTile < minorTiles; ++minorTile) {
        for (let majorTile = 0; majorTile < majorTiles; ++majorTile) {
          result[
            minorTile * minorTileStride +
              majorTile * majorTileStride +
              baseOffset
          ] = inputValue;
        }
      }
    }
  }
  return result;
}

/**
 * Returns the first index in `[begin, end)` for which `predicate` is `true`, or returns `end` if no
 * such index exists.
 *
 * For any index `i` in `(begin, end)`, it must be the case that `predicate(i) >= predicate(i - 1)`.
 */
export function binarySearchLowerBound(
  begin: number,
  end: number,
  predicate: (index: number) => boolean,
): number {
  let count = end - begin;
  while (count > 0) {
    const step = Math.floor(count / 2);
    const i = begin + step;
    if (predicate(i)) {
      count = step;
    } else {
      begin = i + 1;
      count -= step + 1;
    }
  }
  return begin;
}

export function arraysEqual<T>(a: ArrayLike<T>, b: ArrayLike<T>) {
  const length = a.length;
  if (b.length !== length) return false;
  for (let i = 0; i < length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function transposeNestedArrays<T>(x: T[][]) {
  const result: T[][] = [];
  for (
    let outerIndex = 0, outerLength = x.length;
    outerIndex < outerLength;
    ++outerIndex
  ) {
    const inner = x[outerIndex];
    for (
      let innerIndex = 0, innerLength = inner.length;
      innerIndex < innerLength;
      ++innerIndex
    ) {
      let resultInner = result[innerIndex];
      if (resultInner === undefined) {
        resultInner = result[innerIndex] = [];
      }
      resultInner.push(inner[innerIndex]);
    }
  }
  return result;
}

export interface ArraySpliceOp {
  retainCount: number;
  deleteCount: number;
  insertCount: number;
}

