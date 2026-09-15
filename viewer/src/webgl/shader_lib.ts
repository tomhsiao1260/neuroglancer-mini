/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file GLSL types for voxel values.  Integer values are wrapped in a struct named after the data
 * type (e.g. `uint8_t`) so functions can be overloaded per data type; `toRaw` unwraps the value.
 * A 64-bit value is two 32-bit words, low word first.
 */

import { DataType } from "#src/util/data_type.js";

const shaderTypes: Record<DataType, string> = {
  [DataType.UINT8]: "uint8_t",
  [DataType.INT8]: "int8_t",
  [DataType.UINT16]: "uint16_t",
  [DataType.INT16]: "int16_t",
  [DataType.UINT32]: "uint32_t",
  [DataType.INT32]: "int32_t",
  [DataType.UINT64]: "uint64_t",
  [DataType.FLOAT32]: "float",
};

export function getShaderType(dataType: DataType) {
  return shaderTypes[dataType];
}

function defineIntegerType(name: string, valueType: "uint" | "int") {
  return `
struct ${name} {
  highp ${valueType} value;
};
highp ${valueType} toRaw(${name} x) { return x.value; }
`;
}

export const dataTypeShaderDefinition: Record<DataType, string> = {
  [DataType.UINT8]: defineIntegerType("uint8_t", "uint"),
  [DataType.INT8]: defineIntegerType("int8_t", "int"),
  [DataType.UINT16]: defineIntegerType("uint16_t", "uint"),
  [DataType.INT16]: defineIntegerType("int16_t", "int"),
  [DataType.UINT32]: defineIntegerType("uint32_t", "uint"),
  [DataType.INT32]: defineIntegerType("int32_t", "int"),
  [DataType.UINT64]: `
struct uint64_t {
  highp uvec2 value;
};
`,
  [DataType.FLOAT32]: `
highp float toRaw(highp float x) { return x; }
`,
};
