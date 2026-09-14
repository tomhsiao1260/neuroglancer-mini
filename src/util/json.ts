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

const SINGLE_QUOTE_STRING_PATTERN = /('(?:[^'\\]|(?:\\.))*')/;
const DOUBLE_QUOTE_STRING_PATTERN = /("(?:[^"\\]|(?:\\.))*")/;
const SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN = new RegExp(
  `${SINGLE_QUOTE_STRING_PATTERN.source}|${DOUBLE_QUOTE_STRING_PATTERN.source}`,
);
const DOUBLE_OR_SINGLE_QUOTE_STRING_PATTERN = new RegExp(
  `${DOUBLE_QUOTE_STRING_PATTERN.source}|${SINGLE_QUOTE_STRING_PATTERN.source}`,
);

const DOUBLE_QUOTE_PATTERN = /^((?:[^"'\\]|(?:\\[^']))*)("|\\')/;
const SINGLE_QUOTE_PATTERN = /^((?:[^"'\\]|(?:\\.))*)'/;

function convertStringLiteral(
  x: string,
  quoteInitial: string,
  quoteReplace: string,
  quoteSearch: RegExp,
) {
  if (
    x.length >= 2 &&
    x.charAt(0) === quoteInitial &&
    x.charAt(x.length - 1) === quoteInitial
  ) {
    let inner = x.substr(1, x.length - 2);
    let s = quoteReplace;
    while (inner.length > 0) {
      const m = inner.match(quoteSearch);
      if (m === null) {
        s += inner;
        break;
      }
      s += m[1];
      if (m[2] === quoteReplace) {
        // We received a single unescaped quoteReplace character.
        s += "\\";
        s += quoteReplace;
      } else {
        // We received "\\" + quoteInitial.  We need to remove the escaping.
        s += quoteInitial;
      }
      inner = inner.substr(m.index! + m[0].length);
    }
    s += quoteReplace;
    return s;
  }
  return x;
}

// quoteChar: des
function convertJsonHelper(
  x: string,
  desiredCommaChar: string,
  desiredQuoteChar: string,
) {
  const commaSearch = /[&_,]/g;
  let quoteInitial: string;
  let quoteSearch: RegExp;
  let stringLiteralPattern: RegExp;
  if (desiredQuoteChar === '"') {
    quoteInitial = "'";
    quoteSearch = DOUBLE_QUOTE_PATTERN;
    stringLiteralPattern = SINGLE_OR_DOUBLE_QUOTE_STRING_PATTERN;
  } else {
    quoteInitial = '"';
    quoteSearch = SINGLE_QUOTE_PATTERN;
    stringLiteralPattern = DOUBLE_OR_SINGLE_QUOTE_STRING_PATTERN;
  }
  let s = "";
  while (x.length > 0) {
    const m = x.match(stringLiteralPattern);
    let before: string;
    let replacement: string;
    if (m === null) {
      before = x;
      x = "";
      replacement = "";
    } else {
      before = x.substr(0, m.index);
      x = x.substr(m.index! + m[0].length);
      const originalString = m[1];
      if (originalString !== undefined) {
        replacement = convertStringLiteral(
          originalString,
          quoteInitial,
          desiredQuoteChar,
          quoteSearch,
        );
      } else {
        replacement = m[2];
      }
    }
    s += before.replace(commaSearch, desiredCommaChar);
    s += replacement;
  }
  return s;
}

export function urlSafeToJSON(x: string) {
  return convertJsonHelper(x, ",", '"');
}

export function urlSafeParse(x: string) {
  return JSON.parse(urlSafeToJSON(x));
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

export function verifyInt(obj: any) {
  const result = parseInt(obj, 10);
  if (!Number.isInteger(result)) {
    throw new Error(`Expected integer, but received: ${JSON.stringify(obj)}.`);
  }
  return result;
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

/**
 * The query string parameters may either be specified in the usual
 * 'name=value&otherName=otherValue' form or as (optionally urlSafe) JSON: '{"name":"value"}`.
 */
export function parseQueryStringParameters(queryString: string) {
  if (queryString === "") {
    return {};
  }
  if (queryString.startsWith("{")) {
    return urlSafeParse(queryString);
  }
  const result: any = {};
  const parts = queryString.split(/[&;]/);
  for (const part of parts) {
    const m = part.match(/^([^=&;]+)=([^&;]*)$/);
    if (m === null) {
      throw new Error(`Invalid query string part: ${JSON.stringify(part)}.`);
    }
    result[m[1]] = decodeURIComponent(m[2]);
  }
  return result;
}

/**
 * Verifies that `obj' is a string that, when converted to uppercase, matches a string property of
 * `enumType`.
 *
 * @returns The corresponding numerical value.
 */
export function verifyEnumString<T extends number>(
  obj: any,
  enumType: { [x: string]: T | string },
  pattern: RegExp = /^[a-zA-Z]/,
): T {
  if (typeof obj === "string" && obj.match(pattern) !== null) {
    const objUpperCase = obj.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(enumType, objUpperCase)) {
      return enumType[objUpperCase] as T;
    }
  }
  throw new Error(`Invalid enum value: ${JSON.stringify(obj)}.`);
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

export function verifyOptionalFixedLengthArrayOfStringOrNull(
  obj: unknown,
  rank: number,
) {
  if (obj === undefined) {
    const array = new Array<string | null>(rank);
    array.fill(null);
    return array;
  }
  return parseFixedLengthArray(new Array<string | null>(rank), obj, (value) => {
    if (value !== null && typeof value !== "string") {
      throw new Error(
        `Expected string or null, but received: ${JSON.stringify(name)}`,
      );
    }
    return value;
  });
}
