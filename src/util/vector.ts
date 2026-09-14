/**
 * @license
 * Copyright 2019 Google Inc.
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

import type { TypedArray } from "#src/util/array.js";

export function add<
  Out extends TypedArray,
  A extends TypedArray,
  B extends TypedArray,
>(out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] + b[i];
  }
  return out;
}
export function multiply<
  Out extends TypedArray,
  A extends TypedArray,
  B extends TypedArray,
>(out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = a[i] * b[i];
  }
  return out;
}

export function prod(array: ArrayLike<number>) {
  let result = 1;
  for (let i = 0, length = array.length; i < length; ++i) {
    result *= array[i];
  }
  return result;
}

export function min<
  Out extends TypedArray,
  A extends TypedArray,
  B extends TypedArray,
>(out: Out, a: A, b: B) {
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = Math.min(a[i], b[i]);
  }
  return out;
}

export const kEmptyFloat32Vec = new Float32Array(0);
export const kEmptyFloat64Vec = new Float64Array(0);
