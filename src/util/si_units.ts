/**
 * @license
 * Copyright 2019 Google Inc.
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

import { binarySearchLowerBound } from "#src/util/array.js";

export interface SiPrefix {
  readonly prefix: string;
  readonly exponent: number;
  readonly longPrefix?: string;
}

export const preferredSiPrefixes: readonly SiPrefix[] = [
  { prefix: "Y", exponent: 24, longPrefix: "yotta" },
  { prefix: "Z", exponent: 21, longPrefix: "zetta" },
  { prefix: "E", exponent: 18, longPrefix: "exa" },
  { prefix: "P", exponent: 15, longPrefix: "peta" },
  { prefix: "T", exponent: 12, longPrefix: "tera" },
  { prefix: "G", exponent: 9, longPrefix: "giga" },
  { prefix: "M", exponent: 6, longPrefix: "mega" },
  { prefix: "k", exponent: 3, longPrefix: "kilo" },
  { prefix: "", exponent: 0, longPrefix: "" },
  { prefix: "m", exponent: -3, longPrefix: "milli" },
  { prefix: "µ", exponent: -6, longPrefix: "micro" },
  { prefix: "n", exponent: -9, longPrefix: "nano" },
  { prefix: "p", exponent: -12, longPrefix: "pico" },
  { prefix: "f", exponent: -15, longPrefix: "femto" },
  { prefix: "a", exponent: -18, longPrefix: "atto" },
  { prefix: "z", exponent: -21, longPrefix: "zepto" },
  { prefix: "y", exponent: -24, longPrefix: "yocto" },
];

export const allSiPrefixes: readonly SiPrefix[] = [
  ...preferredSiPrefixes,
  { prefix: "h", exponent: 2, longPrefix: "hecto" },
  { prefix: "da", exponent: 1, longPrefix: "deca" },
  { prefix: "d", exponent: -1, longPrefix: "deci" },
  { prefix: "c", exponent: -2, longPrefix: "centi" },
];

const siPrefixesWithAlternatives: readonly SiPrefix[] = [
  { prefix: "u", exponent: -6 }, // Also allow "u" for micro
  ...allSiPrefixes,
];

export const supportedUnits = new Map<
  string,
  { unit: string; exponent: number }
>();
supportedUnits.set("", { unit: "", exponent: 0 });
export const exponentToPrefix = new Map<number, string>();
for (const { prefix, exponent } of siPrefixesWithAlternatives) {
  exponentToPrefix.set(exponent, prefix);
  for (const unit of ["m", "s", "Hz", "rad/s"]) {
    supportedUnits.set(`${prefix}${unit}`, { unit, exponent });
  }
}

export function pickSiPrefix(x: number): SiPrefix {
  const exponent = Math.log10(x);
  const numPrefixes = preferredSiPrefixes.length;
  const i = binarySearchLowerBound(
    0,
    numPrefixes,
    (i) => preferredSiPrefixes[i].exponent <= exponent,
  );
  return preferredSiPrefixes[Math.min(i, numPrefixes - 1)];
}

interface FormatScaleWithUnitOptions {
  precision?: number;
  elide1?: boolean;
}

/**
 * Returns `scale * 10**exponent`, but uses division for negative exponents to reduce loss of
 * precision.
 */
export function scaleByExp10(scale: number, exponent: number) {
  if (exponent >= 0) return scale * 10 ** exponent;
  return scale / 10 ** -exponent;
}
