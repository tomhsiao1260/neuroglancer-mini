/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

interface Node<T> {
  next0: T | null;
  prev0: T | null;
}

export default class {
  static insertAfter<T extends Node<T>>(head: T, x: T) {
    const next = <T>head.next0;
    x.next0 = next;
    x.prev0 = head;
    head.next0 = x;
    next.prev0 = x;
  }
  static front<T extends Node<T>>(head: T) {
    const next = head.next0;
    if (next === head) {
      return null;
    }
    return next;
  }
  static back<T extends Node<T>>(head: T) {
    const next = head.prev0;
    if (next === head) {
      return null;
    }
    return next;
  }
  static pop<T extends Node<T>>(x: T) {
    const next = <T>x.next0;
    const prev = <T>x.prev0;
    next.prev0 = prev;
    prev.next0 = next;
    x.next0 = null;
    x.prev0 = null;
    return x;
  }
  static initializeHead<T extends Node<T>>(head: T) {
    head.next0 = head.prev0 = head;
  }
}
