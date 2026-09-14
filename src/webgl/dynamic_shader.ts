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

import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import type { RefCounted } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

export type ParameterizedContextDependentShaderGetter<Context> = (
  context: Context,
) => ShaderProgram | null;

/**
 * Returns a function that gives the shader for a context, building it on first use and rebuilding
 * it whenever `parameters` changes.  Built programs are shared through `gl.memoize`, keyed by
 * `memoizeKey` and the parameter values.  A shader that fails to build is returned as `null`.
 */
export function parameterizedContextDependentShaderGetter<
  Context,
  ContextKey,
  Parameters,
>(
  refCounted: RefCounted,
  gl: GL,
  options: {
    memoizeKey: any;
    parameters: WatchableValueInterface<Parameters>;
    getContextKey: (context: Context) => ContextKey;
    defineShader: (
      builder: ShaderBuilder,
      context: Context,
      parameters: Parameters,
    ) => void;
  },
): ParameterizedContextDependentShaderGetter<Context> {
  const shaders = new Map<
    ContextKey,
    { shader: ShaderProgram | null; parametersGeneration: number }
  >();
  const { parameters, getContextKey, defineShader } = options;
  const stringMemoizeKey = stableStringify(options.memoizeKey);
  function getNewShader(context: Context, parametersValue: Parameters) {
    const key = JSON.stringify({
      id: stringMemoizeKey,
      parameters: parametersValue,
    });
    return gl.memoize.get(key, () => {
      const builder = new ShaderBuilder(gl);
      defineShader(builder, context, parametersValue);
      return builder.build();
    });
  }
  function getter(context: Context) {
    const contextKey = getContextKey(context);
    let entry = shaders.get(contextKey);
    if (entry === undefined) {
      entry = { shader: null, parametersGeneration: -1 };
      shaders.set(contextKey, entry);
    }
    const parametersGeneration = parameters.changed.count;
    if (parametersGeneration === entry.parametersGeneration) {
      return entry.shader;
    }
    entry.parametersGeneration = parametersGeneration;
    const oldShader = entry.shader;
    let newShader: ShaderProgram | null = null;
    try {
      newShader = getNewShader(context, parameters.value);
    } catch {
      // Leave the shader unset; nothing is drawn with it.
    }
    if (oldShader !== null) {
      oldShader.dispose();
    }
    entry.shader = newShader;
    return newShader;
  }
  refCounted.registerDisposer(() => {
    for (const { shader } of shaders.values()) {
      if (shader !== null) {
        shader.dispose();
      }
    }
  });
  return getter;
}
