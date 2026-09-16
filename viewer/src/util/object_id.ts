/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

const OBJECT_ID_SYMBOL = Symbol("objectId");
let nextObjectId = 0;

/**
 * Returns a string that uniquely identifies a particular primitive value or object instance.
 */
export function getObjectId(x: any) {
  if (x instanceof Object) {
    let id = x[OBJECT_ID_SYMBOL];
    if (id === undefined) {
      id = x[OBJECT_ID_SYMBOL] = nextObjectId++;
    }
    return `o${id}`;
  }
  return "" + JSON.stringify(x);
}
