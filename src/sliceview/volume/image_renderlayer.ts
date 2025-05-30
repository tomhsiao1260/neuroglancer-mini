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

import type { SliceView } from "#src/sliceview/frontend.js";
import type { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import type { RenderLayerBaseOptions } from "#src/sliceview/volume/renderlayer.js";
import { SliceViewVolumeRenderLayer } from "#src/sliceview/volume/renderlayer.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { glsl_COLORMAPS } from "#src/webgl/colormaps.js";
import type { WatchableShaderError } from "#src/webgl/dynamic_shader.js";
import {
  makeTrackableFragmentMain,
  shaderCodeWithLineDirective,
} from "#src/webgl/dynamic_shader.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import type {
  ShaderControlsBuilderState,
  ShaderControlState,
} from "#src/webgl/shader_ui_controls.js";
import {
  addControlsToBuilder,
  getFallbackBuilderState,
  parseShaderUiControls,
  setControlsInShader,
} from "#src/webgl/shader_ui_controls.js";

const DEFAULT_FRAGMENT_MAIN = `#uicontrol invlerp normalized
void main() {
  emitGrayscale(normalized());
}
`;

export function getTrackableFragmentMain(value = DEFAULT_FRAGMENT_MAIN) {
  return makeTrackableFragmentMain(value);
}

export interface ImageRenderLayerOptions extends RenderLayerBaseOptions {
  shaderError: WatchableShaderError;
  shaderControlState: ShaderControlState;
}

export function defineImageLayerShader(
  builder: ShaderBuilder,
  shaderBuilderState: ShaderControlsBuilderState,
) {
  builder.addFragmentCode(`
#define VOLUME_RENDERING false

void emitRGBA(vec4 rgba) {
  emit(rgba);
}
void emitRGB(vec3 rgb) {
  emit(vec4(rgb, 1.0));
}
void emitGrayscale(float value) {
  emit(vec4(value, value, value, 1.0));
}
void emitTransparent() {
  emit(vec4(0.0, 0.0, 0.0, 0.0));
}
void emitIntensity(float value) {
}
`);
  builder.addFragmentCode(glsl_COLORMAPS);
  addControlsToBuilder(shaderBuilderState, builder);
  builder.setFragmentMainFunction(
    shaderCodeWithLineDirective(shaderBuilderState.parseResult.code),
  );
}

export class ImageRenderLayer extends SliceViewVolumeRenderLayer<ShaderControlsBuilderState> {
  shaderControlState: ShaderControlState;
  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: ImageRenderLayerOptions,
  ) {
    const { shaderControlState } = options;
    const shaderParameters = new WatchableValue(
      getFallbackBuilderState(
        parseShaderUiControls(DEFAULT_FRAGMENT_MAIN, {
          imageData: {
            dataType: multiscaleSource.dataType,
            channelRank: options.channelCoordinateSpace?.value?.rank ?? 0,
          },
        }),
      ),
    );
    super(multiscaleSource, {
      ...options,
      fallbackShaderParameters: shaderParameters,
      shaderParameters: shaderControlState.builderState,
    });
    this.shaderControlState = shaderControlState;
    this.registerDisposer(
      shaderControlState.changed.add(this.redrawNeeded.dispatch),
    );
  }

  defineShader(
    builder: ShaderBuilder,
    shaderBuilderState: ShaderControlsBuilderState,
  ) {
    if (shaderBuilderState.parseResult.errors.length !== 0) {
      throw new Error("Invalid UI control specification");
    }
    defineImageLayerShader(builder, shaderBuilderState);
  }

  initializeShader(
    _sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderControlsBuilderState,
  ) {
    setControlsInShader(
      this.gl,
      shader,
      this.shaderControlState,
      parameters.parseResult.controls,
    );
  }
}
