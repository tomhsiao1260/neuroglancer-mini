/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { RefCounted } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";

export class Memoize<Key, Value extends RefCounted> {
  private map = new Map<Key, Value>();

  /**
   * If getter throws an exception, no value is added.
   */
  get<T extends Value>(key: Key, getter: () => T): T {
    const { map } = this;
    let obj = <T>map.get(key);
    if (obj === undefined) {
      obj = getter();
      obj.registerDisposer(() => {
        map.delete(key);
      });
      map.set(key, obj);
    } else {
      obj.addRef();
    }
    return obj;
  }
}

export class StringMemoize extends Memoize<string, RefCounted> {
  get<T extends RefCounted>(x: any, getter: () => T) {
    if (typeof x !== "string") {
      x = stableStringify(x);
    }
    return super.get(x, getter);
  }
}
