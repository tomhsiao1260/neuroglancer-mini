/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

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

