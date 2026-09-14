/**
 * @license
 * Copyright 2020 Google Inc.
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

/**
 * @file Defines lerp/invlerp functionality for all supported data types.
 */

import { DataType, DATA_TYPE_SIGNED } from "#src/util/data_type.js";
import type { DataTypeInterval } from "#src/util/lerp.js";
import { Uint64 } from "#src/util/uint64.js";
import type {
  ShaderBuilder,
  ShaderCodePart,
  ShaderProgram,
} from "#src/webgl/shader.js";
import {
  dataTypeShaderDefinition,
  getShaderType,
  glsl_compareLessThanUint64,
  glsl_shiftRightUint64,
  glsl_subtractUint64,
  glsl_uint64,
} from "#src/webgl/shader_lib.js";

export const dataTypeShaderLerpParametersType: Record<DataType, string> = {
  [DataType.UINT8]: "vec2",
  [DataType.INT8]: "vec2",
  [DataType.UINT16]: "vec2",
  [DataType.INT16]: "vec2",
  [DataType.FLOAT32]: "vec2",
  [DataType.UINT32]: "Uint32LerpParameters",
  [DataType.INT32]: "Int32LerpParameters",
  [DataType.UINT64]: "Uint64LerpParameters",
};

const glsl_dataTypeLerpParameters: Record<DataType, ShaderCodePart> = {
  [DataType.UINT8]: "",
  [DataType.INT8]: "",
  [DataType.UINT16]: "",
  [DataType.INT16]: "",
  [DataType.FLOAT32]: "",
  [DataType.UINT32]: `
struct Uint32LerpParameters {
  uint offset;
  int shift;
  float multiplier;
};
`,
  [DataType.INT32]: `
struct Int32LerpParameters {
  int offset;
  int shift;
  float multiplier;
};
`,
  [DataType.UINT64]: [
    glsl_uint64,
    `
struct Uint64LerpParameters {
  uint64_t offset;
  int shift;
  float multiplier;
};
`,
  ],
};

const glsl_computeInvlerpFloat = `
float computeInvlerp(float inputValue, vec2 p) {
  float outputValue = inputValue;
  outputValue = (outputValue - p[0]) * p[1];
  return outputValue;
}
`;

function getIntFloatInvlerpImpl(dataType: DataType) {
  const shaderDataType = getShaderType(dataType);
  const code = `
float computeInvlerp(${shaderDataType} inputValue, vec2 p) {
  return computeInvlerp(float(toRaw(inputValue)), p);
}
`;
  return [dataTypeShaderDefinition[dataType], glsl_computeInvlerpFloat, code];
}

function getInt32InvlerpImpl(dataType: DataType) {
  const shaderDataType = getShaderType(dataType);
  const scalarType = dataType === DataType.INT32 ? "int" : "uint";
  const pType = dataTypeShaderLerpParametersType[dataType];
  return [
    dataTypeShaderDefinition[dataType],
    glsl_dataTypeLerpParameters[dataType],
    `
float computeInvlerp(${scalarType} v, ${pType} p) {
  uint x;
  if (v >= p.offset) {
    x = uint(v - p.offset);
  } else {
    x = uint(p.offset - v);
    p.multiplier = -p.multiplier;
  }
  x >>= p.shift;
  return float(x) * p.multiplier;
}
float computeInvlerp(${shaderDataType} inputValue, ${pType} p) {
  return computeInvlerp(toRaw(inputValue), p);
}
`,
  ];
}

export const glsl_dataTypeComputeInvlerp: Record<DataType, ShaderCodePart> = {
  [DataType.UINT8]: getIntFloatInvlerpImpl(DataType.UINT8),
  [DataType.INT8]: getIntFloatInvlerpImpl(DataType.INT8),
  [DataType.UINT16]: getIntFloatInvlerpImpl(DataType.UINT16),
  [DataType.INT16]: getIntFloatInvlerpImpl(DataType.INT16),
  [DataType.FLOAT32]: glsl_computeInvlerpFloat,
  [DataType.UINT32]: getInt32InvlerpImpl(DataType.UINT32),
  [DataType.INT32]: getInt32InvlerpImpl(DataType.INT32),
  [DataType.UINT64]: [
    glsl_uint64,
    glsl_compareLessThanUint64,
    glsl_subtractUint64,
    glsl_shiftRightUint64,
    glsl_dataTypeLerpParameters[DataType.UINT64],
    `
float computeInvlerp(uint64_t inputValue, Uint64LerpParameters p) {
  if (compareLessThan(inputValue, p.offset)) {
    inputValue = subtract(p.offset, inputValue);
    p.multiplier = -p.multiplier;
  } else {
    inputValue = subtract(inputValue, p.offset);
  }
  uint shifted = shiftRight(inputValue, p.shift).value[0];
  return float(shifted) * p.multiplier;
}
`,
  ],
};

function defineLerpUniforms(
  builder: ShaderBuilder,
  name: string,
  dataType: DataType,
): ShaderCodePart {
  const pName = `uLerpParams_${name}`;
  const bName = `uLerpBounds_${name}`;
  const sName = `uLerpScalar_${name}`;
  let code = "";
  switch (dataType) {
    case DataType.INT8:
    case DataType.UINT8:
    case DataType.INT16:
    case DataType.UINT16:
    // {uint,int}{8,16} can be converted with float32 without any loss of precision
    // fallthrough
    case DataType.FLOAT32:
      builder.addUniform("vec2", pName);
      break;
    case DataType.INT32:
    case DataType.UINT32: {
      const pType = dataTypeShaderLerpParametersType[dataType];
      builder.addUniform(
        `${dataType === DataType.INT32 ? "i" : "u"}vec2`,
        bName,
      );
      builder.addUniform("float", sName);
      code += `
#define ${pName} ${pType}(${bName}[0], int(${bName}[1]), ${sName})
`;
      break;
    }
    case DataType.UINT64: {
      builder.addUniform("uvec3", bName);
      builder.addUniform("float", sName);
      code += `
#define ${pName} Uint64LerpParameters(uint64_t(${bName}.xy), int(${bName}[2]), ${sName})
`;
      break;
    }
  }
  return [glsl_dataTypeLerpParameters[dataType], code];
}

export function defineInvlerpShaderFunction(
  builder: ShaderBuilder,
  name: string,
  dataType: DataType,
  clamp = false,
): ShaderCodePart {
  const shaderType = getShaderType(dataType);
  let code = `
float ${name}(${shaderType} inputValue) {
  float v = computeInvlerp(inputValue, uLerpParams_${name});
  ${!clamp ? "" : "v = clamp(v, 0.0, 1.0);"}
  defaultMaxProjectionIntensity = v;
  return v;
}
`;
  if (dataType !== DataType.UINT64 && dataType !== DataType.FLOAT32) {
    const scalarType = DATA_TYPE_SIGNED[dataType] ? "int" : "uint";
    code += `
float ${name}(${scalarType} inputValue) {
  return ${name}(${shaderType}(inputValue));
}
`;
  }
  return [
    dataTypeShaderDefinition[dataType],
    defineLerpUniforms(builder, name, dataType),
    glsl_dataTypeComputeInvlerp[dataType],
    code,
  ];
}

const tempUint64 = new Uint64();

export function enableLerpShaderFunction(
  shader: ShaderProgram,
  name: string,
  dataType: DataType,
  interval: DataTypeInterval,
) {
  const { gl } = shader;
  switch (dataType) {
    case DataType.INT8:
    case DataType.UINT8:
    case DataType.INT16:
    case DataType.UINT16:
    case DataType.FLOAT32:
      gl.uniform2f(
        shader.uniform(`uLerpParams_${name}`),
        interval[0] as number,
        1 / ((interval[1] as number) - (interval[0] as number)),
      );
      break;
    case DataType.INT32:
    case DataType.UINT32: {
      const lower = interval[0] as number;
      const diff = (interval[1] as number) - lower;
      const shift = Math.max(0, Math.ceil(Math.log2(Math.abs(diff))) - 24);
      const scalar = 2 ** shift / diff;
      const bLocation = shader.uniform(`uLerpBounds_${name}`);
      if (dataType === DataType.UINT32) {
        gl.uniform2ui(bLocation, lower, shift);
      } else {
        gl.uniform2i(bLocation, lower, shift);
      }
      gl.uniform1f(shader.uniform(`uLerpScalar_${name}`), scalar);
      break;
    }
    case DataType.UINT64: {
      const lower = interval[0] as Uint64;
      const upper = interval[1] as Uint64;
      Uint64.absDifference(tempUint64, upper, lower);
      const numBits =
        tempUint64.high > 0
          ? 32 + Math.ceil(Math.log2(tempUint64.high))
          : Math.ceil(Math.log2(tempUint64.low));
      const shift = Math.max(0, numBits - 24);
      Uint64.rshift(tempUint64, tempUint64, shift);
      let scalar = 1 / tempUint64.low;
      if (Uint64.compare(lower, upper) > 0) {
        scalar *= -1;
      }
      const bLocation = shader.uniform(`uLerpBounds_${name}`);
      gl.uniform3ui(bLocation, lower.low, lower.high, shift);
      gl.uniform1f(shader.uniform(`uLerpScalar_${name}`), scalar);
    }
  }
}
