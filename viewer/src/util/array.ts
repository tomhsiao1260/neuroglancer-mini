/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

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

export function arraysEqual<T>(a: ArrayLike<T>, b: ArrayLike<T>) {
  const length = a.length;
  if (b.length !== length) return false;
  for (let i = 0; i < length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

