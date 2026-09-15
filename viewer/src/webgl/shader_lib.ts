/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file GLSL types for voxel values.  Integer values are wrapped in a struct named after the data
 * type (e.g. `uint8_t`) so functions can be overloaded per data type; `toRaw` unwraps the value.
 */

import { DataType } from "#src/util/data_type.js";

const shaderTypes: Record<DataType, string> = {
  [DataType.UINT8]: "uint8_t",
  [DataType.UINT16]: "uint16_t",
  [DataType.FLOAT32]: "float",
};

export function getShaderType(dataType: DataType) {
  return shaderTypes[dataType];
}

function defineIntegerType(name: string) {
  return `
struct ${name} {
  highp uint value;
};
highp uint toRaw(${name} x) { return x.value; }
`;
}

export const dataTypeShaderDefinition: Record<DataType, string> = {
  [DataType.UINT8]: defineIntegerType("uint8_t"),
  [DataType.UINT16]: defineIntegerType("uint16_t"),
  [DataType.FLOAT32]: `
highp float toRaw(highp float x) { return x; }
`,
};
