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
import {
  defaultDataTypeRange,
  defineInvlerpShaderFunction,
  enableLerpShaderFunction,
} from "#src/webgl/lerp.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

/**
 * Draws the volume in grayscale.  `normalized()` maps the data value at the current voxel from the
 * full range of the data type onto [0, 1].
 */
export class ImageRenderLayer extends SliceViewVolumeRenderLayer {
  defineShader(builder: ShaderBuilder, numChannelDimensions: number) {
    const channel = new Array(numChannelDimensions).fill(0);
    builder.addFragmentCode([
      defineInvlerpShaderFunction(
        builder,
        "normalized",
        this.dataType,
        /*clamp=*/ true,
      ),
      `
float normalized() {
  return normalized(getDataValue(${channel.join(",")}));
}
`,
    ]);
    builder.setFragmentMainFunction(`
void main() {
  float value = normalized();
  emit(vec4(value, value, value, 1.0));
}
`);
  }

  initializeShader(shader: ShaderProgram) {
    const { dataType } = this;
    enableLerpShaderFunction(
      shader,
      "normalized",
      dataType,
      defaultDataTypeRange[dataType],
    );
  }
}
