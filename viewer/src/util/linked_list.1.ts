/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

interface Node<T> {
  next1: T | null;
  prev1: T | null;
}

export default class {
  static insertAfter<T extends Node<T>>(head: T, x: T) {
    const next = <T>head.next1;
    x.next1 = next;
    x.prev1 = head;
    head.next1 = x;
    next.prev1 = x;
  }
  static front<T extends Node<T>>(head: T) {
    const next = head.next1;
    if (next === head) {
      return null;
    }
    return next;
  }
  static back<T extends Node<T>>(head: T) {
    const next = head.prev1;
    if (next === head) {
      return null;
    }
    return next;
  }
  static pop<T extends Node<T>>(x: T) {
    const next = <T>x.next1;
    const prev = <T>x.prev1;
    next.prev1 = prev;
    prev.next1 = next;
    x.next1 = null;
    x.prev1 = null;
    return x;
  }
  static initializeHead<T extends Node<T>>(head: T) {
    head.next1 = head.prev1 = head;
  }
}
