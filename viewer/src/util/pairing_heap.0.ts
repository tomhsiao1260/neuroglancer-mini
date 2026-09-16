/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { PairingHeapOperations } from "#src/util/pairing_heap.js";

interface Node<T> {
  child0: T | null;
  next0: T | null;
  prev0: T | null;
}

/**
 * Pairing heap.
 *
 * The root node is the minimum element according to comparator.
 *
 * @final
 */
export default class Implementation<T extends Node<T>>
  implements PairingHeapOperations<T>
{
  /**
   * @param compare Returns true iff a < b.
   */
  constructor(public compare: (a: T, b: T) => boolean) {}

  meld(a: T | null, b: T | null) {
    if (b === null) {
      return a;
    }
    if (a === null) {
      return b;
    }
    const { compare } = this;
    if (compare(b, a)) {
      const temp = a;
      a = b;
      b = temp;
    }
    const aChild = a.child0;
    b.next0 = aChild;
    b.prev0 = a;
    if (aChild !== null) {
      aChild.prev0 = b;
    }
    a.child0 = b;
    return a;
  }
  private combineChildren(node: T) {
    let cur = node.child0;
    if (cur === null) {
      return null;
    }
    // While in this function, we will use the nextProperty to create a
    // singly-linked list of pairwise-merged nodes that still need to be
    // merged together.
    let head: T | null = null;
    while (true) {
      const curNext: T | null = cur.next0;
      let next: T | null;
      let m: T;
      if (curNext === null) {
        next = null;
        m = cur;
      } else {
        next = curNext.next0;
        m = this.meld(cur, curNext)!;
      }
      m.next0 = head;
      head = m;
      if (next === null) {
        break;
      }
      cur = next;
    }

    let root = head;
    head = head.next0;
    while (true) {
      if (head === null) {
        break;
      }
      const next: T | null = head.next0;
      root = this.meld(root, head)!;
      head = next;
    }
    root.prev0 = null;
    root.next0 = null;
    return root;
  }
  removeMin(root: T) {
    const newRoot = this.combineChildren(root);
    root.next0 = null;
    root.prev0 = null;
    root.child0 = null;
    return newRoot;
  }

  remove(root: T, node: T) {
    if (root === node) {
      return this.removeMin(root);
    }
    const prev = node.prev0!;
    const next = node.next0!;
    if (prev.child0 === node) {
      prev.child0 = next;
    } else {
      prev.next0 = next;
    }
    if (next !== null) {
      next.prev0 = prev;
    }
    const newRoot = this.meld(root, this.combineChildren(node));
    node.next0 = null;
    node.prev0 = null;
    node.child0 = null;
    return newRoot;
  }
}
