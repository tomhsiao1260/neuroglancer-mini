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

import { ChunkState } from "#src/chunk_manager/base.js";
import {
  defineBoundingBoxCrossSectionShader,
  setBoundingBoxCrossSectionShaderViewportPlane,
} from "#src/sliceview/bounding_box_shader_helper.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type {
  FrontendTransformedSource,
  SliceView,
} from "#src/sliceview/frontend.js";
import type {
  SliceViewRenderContext,
  SliceViewRenderLayerOptions,
} from "#src/sliceview/renderlayer.js";
import { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type { ChunkFormat } from "#src/sliceview/volume/chunk_format.js";
import type {
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { mat4, vec3 } from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

/**
 * Extra amount by which the chunk position computed in the vertex shader is shifted in the
 * direction of the component-wise absolute value of the plane normal.  In Neuroglancer, a
 * cross-section plane exactly on the boundary between two voxels is a common occurrence and is
 * intended to result in the display of the "next" (i.e. higher coordinate) plane rather than the
 * "previous" (lower coordinate) plane.  However, due to various sources of floating point
 * inaccuracy (in particular, shader code which has relaxed rules), values exactly on the boundary
 * between voxels may be slightly shifted in either direction.  To ensure that this doesn't result
 * in the display of the wrong data (i.e. the previous rather than next plane), we always shift
 * toward the "next" plane by this small amount.
 */
const CHUNK_POSITION_EPSILON = 1e-3;

const tempMat4 = mat4.create();

function defineVolumeShader(builder: ShaderBuilder) {
  defineVertexId(builder);
  defineBoundingBoxCrossSectionShader(builder);

  // Specifies translation of the current chunk.
  builder.addUniform("highp vec3", "uTranslation");

  // Matrix by which computed vertices will be transformed.
  builder.addUniform("highp mat4", "uProjectionMatrix");

  // Chunk size in voxels.
  builder.addUniform("highp vec3", "uChunkDataSize");

  builder.addUniform("highp vec3", "uLowerClipBound");
  builder.addUniform("highp vec3", "uUpperClipBound");

  // Position within chunk of vertex, in floating point range [0, chunkDataSize].
  builder.addVarying("highp vec3", "vChunkPosition");

  // Set gl_Position.z = 0 since we use the depth buffer as a stencil buffer to avoid overwriting
  // higher-resolution data with lower-resolution data.
  builder.setVertexMain(`
vec3 position = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, gl_VertexID);
gl_Position = uProjectionMatrix * vec4(position, 1.0);
gl_Position.z = 0.0;
vChunkPosition = (position - uTranslation) +
    ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
`);

  builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
  builder.addFragmentCode(`
void emit(vec4 color) {
  v4f_fragData0 = color;
}
`);
}

function beginSource(
  gl: GL,
  shader: ShaderProgram,
  sliceView: SliceView,
  dataToDeviceMatrix: mat4,
  tsource: FrontendTransformedSource,
  chunkLayout: ChunkLayout,
) {
  const projectionParameters = sliceView.projectionParameters.value;
  const { centerDataPosition } = projectionParameters;

  setBoundingBoxCrossSectionShaderViewportPlane(
    shader,
    projectionParameters.viewportNormalInGlobalCoordinates,
    centerDataPosition,
    chunkLayout.transform,
    chunkLayout.invTransform,
  );

  // Compute projection matrix that transforms chunk layout coordinates to device coordinates.
  gl.uniformMatrix4fv(
    shader.uniform("uProjectionMatrix"),
    false,
    mat4.multiply(tempMat4, dataToDeviceMatrix, chunkLayout.transform),
  );

  gl.uniform3fv(
    shader.uniform("uLowerClipBound"),
    tsource.lowerClipDisplayBound,
  );
  gl.uniform3fv(
    shader.uniform("uUpperClipBound"),
    tsource.upperClipDisplayBound,
  );
}

/**
 * Draws the visible chunks of a volume: for each chunk, the polygon where the slice plane cuts the
 * chunk's box, textured with the chunk's data.  Subclasses turn the data value into a color.
 */
export abstract class SliceViewVolumeRenderLayer extends SliceViewRenderLayer<VolumeChunkSource> {
  multiscaleSource: MultiscaleVolumeChunkSource;
  private vertexIdHelper: VertexIdHelper;
  // Shader for each chunk format, built on first use; `null` if it failed to build.
  private shaders = new Map<ChunkFormat, ShaderProgram | null>();

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: SliceViewRenderLayerOptions,
  ) {
    super(multiscaleSource.chunkManager, multiscaleSource, options);
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));
    this.registerDisposer(() => {
      for (const shader of this.shaders.values()) {
        shader?.dispose();
      }
    });
    this.initializeCounterpart();
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  // Adds the fragment shader `main`, which turns `getDataValue()` into a color passed to `emit`.
  abstract defineShader(builder: ShaderBuilder): void;

  // Sets the uniforms used by the code added in `defineShader`.
  abstract initializeShader(shader: ShaderProgram): void;

  private getShader(chunkFormat: ChunkFormat) {
    let shader = this.shaders.get(chunkFormat);
    if (shader === undefined) {
      shader = null;
      try {
        const builder = new ShaderBuilder(this.gl);
        defineVolumeShader(builder);
        chunkFormat.defineShader(builder);
        this.defineShader(builder);
        shader = builder.build();
      } catch {
        // Leave the shader unset; nothing is drawn with it.
      }
      this.shaders.set(chunkFormat, shader);
    }
    return shader;
  }

  private beginChunkFormat(chunkFormat: ChunkFormat) {
    const shader = this.getShader(chunkFormat);
    if (shader !== null) {
      shader.bind();
      this.initializeShader(shader);
      chunkFormat.beginDrawing(this.gl);
    }
    return shader;
  }

  draw(renderContext: SliceViewRenderContext) {
    const { sliceView, projectionParameters } = renderContext;
    const layerInfo = sliceView.visibleLayers.get(this)!;
    const { visibleSources } = layerInfo;
    if (visibleSources.length === 0) {
      return;
    }

    const { gl } = this;

    this.vertexIdHelper.enable();

    const chunkPosition = vec3.create();

    let shader: ShaderProgram | null = null;
    let prevChunkFormat: ChunkFormat | undefined;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const endShader = () => {
      if (shader === null) return;
      prevChunkFormat!.endDrawing(gl);
    };
    let newSource = true;
    for (const transformedSource of visibleSources) {
      const { chunkLayout } = transformedSource;
      const source = transformedSource.source as VolumeChunkSource;
      const { fixedPositionWithinChunk, chunkDisplayDimensionIndices } =
        transformedSource;
      for (const chunkDim of chunkDisplayDimensionIndices) {
        fixedPositionWithinChunk[chunkDim] = 0;
      }
      const { chunkFormat } = source;
      if (chunkFormat !== prevChunkFormat) {
        endShader();
        prevChunkFormat = chunkFormat;
        shader = this.beginChunkFormat(chunkFormat);
      }
      if (shader === null) continue;
      const chunks = source.chunks;

      chunkDataDisplaySize.fill(1);

      const originalChunkSize = chunkLayout.size;

      let chunkDataSize: Uint32Array | undefined;
      const chunkRank = source.spec.rank;

      beginSource(
        gl,
        shader,
        sliceView,
        projectionParameters.viewProjectionMat,
        transformedSource,
        chunkLayout,
      );
      newSource = true;
      sliceView.forEachVisibleChunk(transformedSource, chunkLayout, (key) => {
        const chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          const newChunkDataSize = chunk.chunkDataSize;
          if (newChunkDataSize !== chunkDataSize) {
            chunkDataSize = newChunkDataSize;
            for (let i = 0; i < 3; ++i) {
              const chunkDim = chunkDisplayDimensionIndices[i];
              chunkDataDisplaySize[i] =
                chunkDim === -1 || chunkDim >= chunkRank
                  ? 1
                  : chunkDataSize[chunkDim];
            }
            gl.uniform3fv(shader!.uniform("uChunkDataSize"), chunkDataDisplaySize);
          }
          const { chunkGridPosition } = chunk;
          for (let i = 0; i < 3; ++i) {
            const chunkDim = chunkDisplayDimensionIndices[i];
            chunkPosition[i] =
              chunkDim === -1 || chunkDim >= chunkRank
                ? 0
                : originalChunkSize[i] * chunkGridPosition[chunkDim];
          }
          chunkFormat.bindChunk(
            gl,
            shader!,
            chunk,
            fixedPositionWithinChunk,
            chunkDisplayDimensionIndices,
            newSource,
          );
          newSource = false;
          gl.uniform3fv(shader!.uniform("uTranslation"), chunkPosition);
          gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);
        }
      });
    }
    endShader();
  }
}
