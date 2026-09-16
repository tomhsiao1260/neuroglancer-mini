/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

export interface LinkedListOperations<T> {
  insertAfter: (head: T, x: T) => void;
  pop: (head: T) => T;
  front: (head: T) => T | null;
  back: (head: T) => T | null;
  initializeHead: (head: T) => void;
}
