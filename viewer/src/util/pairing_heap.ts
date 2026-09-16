/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

export interface ComparisonFunction<T> {
  (a: T, b: T): boolean;
}

export interface PairingHeapOperations<T> {
  meld: (a: T | null, b: T | null) => T | null;
  compare: ComparisonFunction<T>;
  removeMin: (root: T) => T | null;
  remove: (root: T, node: T) => T | null;
}
