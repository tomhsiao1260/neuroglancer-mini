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

import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { DataType } from "#src/util/data_type.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import {
  dataTypeShaderDefinition,
  getShaderType,
} from "#src/webgl/shader_lib.js";

// Full range of each data type except UINT64, whose range is handled in `setNormalizedUniforms`.
const dataTypeRange: { [dataType: number]: [number, number] } = {
  [DataType.UINT8]: [0, 0xff],
  [DataType.INT8]: [-0x80, 0x7f],
  [DataType.UINT16]: [0, 0xffff],
  [DataType.INT16]: [-0x8000, 0x7fff],
  [DataType.UINT32]: [0, 0xffffffff],
  [DataType.INT32]: [-0x80000000, 0x7fffffff],
  [DataType.FLOAT32]: [0, 1],
};

const glsl_uint64Arithmetic = `
bool compareLessThan(uint64_t a, uint64_t b) {
  return (a.value[1] < b.value[1])||
         (a.value[1] == b.value[1] && a.value[0] < b.value[0]);
}
uint64_t subtract(uint64_t a, uint64_t b) {
  if (a.value[0] < b.value[0]) {
    --a.value[1];
  }
  a.value -= b.value;
  return a;
}
uint64_t shiftRight(uint64_t a, int shift) {
  if (shift >= 32) {
    return uint64_t(uvec2(a.value[1] >> (shift - 32), 0u));
  } else if (shift == 0) {
    return a;
  } else {
    return uint64_t(uvec2((a.value[0] >> shift) | (a.value[1] << (32 - shift)), a.value[1] >> shift));
  }
}
`;

/**
 * Returns the code of `float normalized(value)`, which maps a data value from the range of its
 * data type onto [0, 1].  8- and 16-bit integers are exact as floats.  For 32- and 64-bit integers
 * the offset from the lower bound is shifted right to 24 bits before it is converted to float.
 */
function defineNormalized(builder: ShaderBuilder, dataType: DataType) {
  const shaderType = getShaderType(dataType);
  let code: string;
  switch (dataType) {
    case DataType.UINT32:
    case DataType.INT32: {
      const scalarType = dataType === DataType.INT32 ? "int" : "uint";
      // [lower bound, shift]
      builder.addUniform(`${scalarType[0]}vec2`, "uLerpBounds");
      builder.addUniform("float", "uLerpScalar");
      code = `
float normalized(${shaderType} inputValue) {
  ${scalarType} v = toRaw(inputValue);
  ${scalarType} offset = uLerpBounds[0];
  float multiplier = uLerpScalar;
  uint x;
  if (v >= offset) {
    x = uint(v - offset);
  } else {
    x = uint(offset - v);
    multiplier = -multiplier;
  }
  x >>= int(uLerpBounds[1]);
  return clamp(float(x) * multiplier, 0.0, 1.0);
}
`;
      break;
    }
    case DataType.UINT64:
      // [lower bound low word, lower bound high word, shift]
      builder.addUniform("uvec3", "uLerpBounds");
      builder.addUniform("float", "uLerpScalar");
      code = `${glsl_uint64Arithmetic}
float normalized(uint64_t inputValue) {
  uint64_t offset = uint64_t(uLerpBounds.xy);
  float multiplier = uLerpScalar;
  if (compareLessThan(inputValue, offset)) {
    inputValue = subtract(offset, inputValue);
    multiplier = -multiplier;
  } else {
    inputValue = subtract(inputValue, offset);
  }
  uint shifted = shiftRight(inputValue, int(uLerpBounds[2])).value[0];
  return clamp(float(shifted) * multiplier, 0.0, 1.0);
}
`;
      break;
    default:
      // [lower bound, 1 / (upper bound - lower bound)]
      builder.addUniform("vec2", "uLerpParams");
      code = `
float normalized(${shaderType} inputValue) {
  float v = (float(toRaw(inputValue)) - uLerpParams[0]) * uLerpParams[1];
  return clamp(v, 0.0, 1.0);
}
`;
  }
  return [dataTypeShaderDefinition[dataType], code];
}

function setNormalizedUniforms(shader: ShaderProgram, dataType: DataType) {
  const { gl } = shader;
  switch (dataType) {
    case DataType.UINT32:
    case DataType.INT32: {
      const [lower, upper] = dataTypeRange[dataType];
      const diff = upper - lower;
      const shift = Math.max(0, Math.ceil(Math.log2(Math.abs(diff))) - 24);
      const scalar = 2 ** shift / diff;
      const location = shader.uniform("uLerpBounds");
      if (dataType === DataType.UINT32) {
        gl.uniform2ui(location, lower, shift);
      } else {
        gl.uniform2i(location, lower, shift);
      }
      gl.uniform1f(shader.uniform("uLerpScalar"), scalar);
      break;
    }
    case DataType.UINT64:
      // Range [0, 2^64 - 1]: the 64-bit difference is shifted right by 40 bits, leaving at most
      // 2^24 - 1.
      gl.uniform3ui(shader.uniform("uLerpBounds"), 0, 0, 40);
      gl.uniform1f(shader.uniform("uLerpScalar"), 1 / 0xffffff);
      break;
    default: {
      const [lower, upper] = dataTypeRange[dataType];
      gl.uniform2f(shader.uniform("uLerpParams"), lower, 1 / (upper - lower));
    }
  }
}

/**
 * Draws the volume in grayscale: the data value at each point, mapped from the full range of the
 * data type onto [0, 1].
 */
export class ImageRenderLayer extends SliceViewVolumeRenderLayer {
  defineShader(builder: ShaderBuilder) {
    builder.addFragmentCode(defineNormalized(builder, this.dataType));
    builder.setFragmentMain(`
  float value = normalized(getDataValue());
  emit(vec4(value, value, value, 1.0));
`);
  }

  initializeShader(shader: ShaderProgram) {
    setNormalizedUniforms(shader, this.dataType);
  }
}
