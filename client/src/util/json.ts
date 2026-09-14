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

import type { WritableArrayLike } from "#src/util/array.js";

export function verifyFloat(obj: any): number {
  const t = typeof obj;
  if (t === "number" || t === "string") {
    const x = parseFloat("" + obj);
    if (!Number.isNaN(x)) {
      return x;
    }
  }
  throw new Error(
    `Expected floating-point number, but received: ${JSON.stringify(obj)}.`,
  );
}

export function verifyFiniteFloat(obj: any): number {
  const x = verifyFloat(obj);
  if (Number.isFinite(x)) {
    return x;
  }
  throw new Error(`Expected finite floating-point number, but received: ${x}.`);
}

export function verifyFinitePositiveFloat(obj: any): number {
  const x = verifyFiniteFloat(obj);
  if (x > 0) {
    return x;
  }
  throw new Error(
    `Expected positive finite floating-point number, but received: ${x}.`,
  );
}

/**
 * Returns a JSON representation of x, with object keys sorted to ensure a
 * consistent result.
 */
export function stableStringify(x: any) {
  if (typeof x === "object") {
    if (x === null) {
      return "null";
    }
    if (Array.isArray(x)) {
      let s = "[";
      const size = x.length;
      let i = 0;
      if (i < size) {
        s += stableStringify(x[i]);
        while (++i < size) {
          s += ",";
          s += stableStringify(x[i]);
        }
      }
      s += "]";
      return s;
    }
    let s = "{";
    const keys = Object.keys(x).sort();
    let i = 0;
    const size = keys.length;
    if (i < size) {
      let key = keys[i];
      s += JSON.stringify(key);
      s += ":";
      s += stableStringify(x[key]);
      while (++i < size) {
        s += ",";
        key = keys[i];
        s += JSON.stringify(key);
        s += ":";
        s += stableStringify(x[key]);
      }
    }
    s += "}";
    return s;
  }
  return JSON.stringify(x);
}

function swapQuotes(x: string) {
  return x.replace(/['"]/g, (s) => {
    return s === '"' ? "'" : '"';
  });
}

export function urlSafeStringifyString(x: string) {
  return swapQuotes(JSON.stringify(swapQuotes(x)));
}

const URL_SAFE_COMMA = "_";

export function urlSafeStringify(x: any): string {
  if (typeof x === "object") {
    if (x === null) {
      return "null";
    }
    const toJSON = x.toJSON;
    if (typeof toJSON === "function") {
      return urlSafeStringify(toJSON.call(x));
    }
    if (Array.isArray(x)) {
      let s = "[";
      const size = x.length;
      let i = 0;
      if (i < size) {
        s += urlSafeStringify(x[i]);
        while (++i < size) {
          s += URL_SAFE_COMMA;
          s += urlSafeStringify(x[i]);
        }
      }
      s += "]";
      return s;
    }
    let s = "{";
    const keys = Object.keys(x);
    let first = true;
    for (const key of keys) {
      const value = x[key];
      if (value === undefined) {
        continue;
      }
      const valueString = urlSafeStringify(value);
      if (!valueString) {
        continue;
      }
      if (!first) {
        s += URL_SAFE_COMMA;
      } else {
        first = false;
      }
      s += urlSafeStringifyString(key);
      s += ":";
      s += valueString;
    }
    s += "}";
    return s;
  }
  if (typeof x === "string") {
    return urlSafeStringifyString(x);
  }
  return JSON.stringify(x);
}



// Checks that `x' is an array, maps each element by parseElement.
export function parseArray<T>(
  x: any,
  parseElement: (x: any, index: number) => T,
): T[] {
  if (!Array.isArray(x)) {
    throw new Error(`Expected array, but received: ${JSON.stringify(x)}.`);
  }
  return (<any[]>x).map(parseElement);
}

export function parseFixedLengthArray<T, U extends WritableArrayLike<T>>(
  out: U,
  obj: any,
  parseElement: (x: any, index: number) => T,
): U {
  const length = out.length;
  if (!Array.isArray(obj) || obj.length !== length) {
    throw new Error(
      `Expected length ${length} array, but received: ${JSON.stringify(obj)}.`,
    );
  }
  for (let i = 0; i < length; ++i) {
    out[i] = parseElement(obj[i], i);
  }
  return out;
}

export function verifyObject(obj: any) {
  if (typeof obj !== "object" || obj == null || Array.isArray(obj)) {
    throw new Error(
      `Expected JSON object, but received: ${JSON.stringify(obj)}.`,
    );
  }
  return obj;
}

export function verifyString(obj: any) {
  if (typeof obj !== "string") {
    throw new Error(`Expected string, but received: ${JSON.stringify(obj)}.`);
  }
  return obj;
}

export function verifyObjectProperty<T>(
  obj: any,
  propertyName: string,
  validator: (value: any) => T,
): T {
  const value = Object.prototype.hasOwnProperty.call(obj, propertyName)
    ? obj[propertyName]
    : undefined;
  try {
    return validator(value);
  } catch (parseError) {
    throw new Error(
      `Error parsing ${JSON.stringify(propertyName)} property: ${
        parseError.message
      }`,
    );
  }
}

export function verifyOptionalObjectProperty<T>(
  obj: any,
  propertyName: string,
  validator: (value: any) => T,
): T | undefined;

export function verifyOptionalObjectProperty<T>(
  obj: any,
  propertyName: string,
  validator: (value: any) => T,
  defaultValue: T,
): T;

export function verifyOptionalObjectProperty<T>(
  obj: any,
  propertyName: string,
  validator: (value: any) => T,
  defaultValue?: any,
) {
  return verifyObjectProperty(obj, propertyName, (x) =>
    x === undefined ? defaultValue : validator(x),
  );
}

export function verifyConstant<T>(actual: unknown, expected: T) {
  if (actual !== expected) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, but received: ${JSON.stringify(
        actual,
      )}`,
    );
  }
  return expected;
}

