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
import type { CoordinateSpace } from "#src/state/coordinate_transform.js";
import { emptyInvalidCoordinateSpace } from "#src/state/coordinate_transform.js";
import type { ProjectionParameters } from "#src/render/projection_parameters.js";
import { getNormalizedChunkLayout } from "#src/sliceview/base.js";
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
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import type {
  ChunkFormat,
  MultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { defineChunkDataShaderAccess } from "#src/sliceview/volume/frontend.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import {
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
} from "#src/state/trackable_value.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { getObjectId } from "#src/util/object_id.js";
import type { GL } from "#src/webgl/context.js";
import type {
  ParameterizedContextDependentShaderGetter,
  ParameterizedShaderGetterResult,
  WatchableShaderError,
} from "#src/webgl/dynamic_shader.js";
import {
  makeWatchableShaderError,
  parameterizedContextDependentShaderGetter,
} from "#src/webgl/dynamic_shader.js";
import type { HistogramChannelSpecification } from "#src/webgl/empirical_cdf.js";
import {
  defineLineShader,
  initializeLineShader,
  VERTICES_PER_LINE,
} from "#src/webgl/lines.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

const DEBUG_VERTICES = false;

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

function defineVolumeShader(builder: ShaderBuilder, wireFrame: boolean) {
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

  if (wireFrame) {
    defineLineShader(builder);
    builder.setVertexMain(`
int vertexIndex1 = gl_VertexID / ${VERTICES_PER_LINE};
int vertexIndex2 = vertexIndex1 == 5 ? 0 : vertexIndex1 + 1;
vec3 vertexPosition1 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex1);
vec3 vertexPosition2 = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, vertexIndex2);
emitLine(uProjectionMatrix * vec4(vertexPosition1, 1.0),
         uProjectionMatrix * vec4(vertexPosition2, 1.0),
         2.0);
`);
    builder.setFragmentMain(`
emit(vec4(1.0, 1.0, 1.0, getLineAlpha()));
`);
    return;
  }

  // Position within chunk of vertex, in floating point range [0, chunkDataSize].
  builder.addVarying("highp vec3", "vChunkPosition");

  // Set gl_Position.z = 0 since we use the depth buffer as a stencil buffer to avoid overwriting
  // higher-resolution data with lower-resolution data.  The depth buffer is used rather than the
  // stencil buffer because for computing data distributions we need to read from it, and WebGL2
  // does not support reading from the stencil component of a depth-stencil texture.
  builder.setVertexMain(`
vec3 position = getBoundingBoxPlaneIntersectionVertexPosition(uChunkDataSize, uTranslation, uLowerClipBound, uUpperClipBound, gl_VertexID);
gl_Position = uProjectionMatrix * vec4(position, 1.0);
gl_Position.z = 0.0;
vChunkPosition = (position - uTranslation) +
    ${CHUNK_POSITION_EPSILON} * abs(uPlaneNormal);
`);
}

function initializeShader(
  shader: ShaderProgram,
  projectionParameters: ProjectionParameters,
  wireFrame: boolean,
) {
  if (wireFrame) {
    initializeLineShader(
      shader,
      projectionParameters,
      /*featherWidthInPixels=*/ 1,
    );
  }
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
  if (DEBUG_VERTICES) {
    (<any>window).debug_sliceView_uLowerClipBound =
      tsource.lowerClipDisplayBound;
    (<any>window).debug_sliceView_uUpperClipBound =
      tsource.upperClipDisplayBound;
    (<any>window).debug_sliceView = sliceView;
    (<any>window).debug_sliceView_dataToDevice = mat4.clone(tempMat4);
    (<any>window).debug_sliceView_chunkLayout = chunkLayout;
  }
}

function setupChunkDataSize(
  gl: GL,
  shader: ShaderProgram,
  chunkDataSize: vec3,
) {
  gl.uniform3fv(shader.uniform("uChunkDataSize"), chunkDataSize);

  if (DEBUG_VERTICES) {
    (<any>window).debug_sliceView_chunkDataSize = chunkDataSize;
  }
}

function drawChunk(
  gl: GL,
  shader: ShaderProgram,
  chunkPosition: vec3,
  wireFrame: boolean,
) {
  gl.uniform3fv(shader.uniform("uTranslation"), chunkPosition);
  gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);

  if (DEBUG_VERTICES) {
    const sliceView: SliceView = (<any>window).debug_sliceView;
    const chunkDataSize: vec3 = (<any>window).debug_sliceView_chunkDataSize;
    const dataToDeviceMatrix: mat4 = (<any>window).debug_sliceView_dataToDevice;
    console.log(
      `Drawing chunk: ${chunkPosition.join()} of data size ` +
        `${chunkDataSize.join()}, projection`,
      dataToDeviceMatrix,
    );
  }
}

export interface RenderLayerBaseOptions extends SliceViewRenderLayerOptions {
  shaderError?: WatchableShaderError;
  channelCoordinateSpace?: WatchableValueInterface<CoordinateSpace>;
}

export interface RenderLayerOptions<ShaderParameters>
  extends RenderLayerBaseOptions {
  fallbackShaderParameters?: WatchableValueInterface<ShaderParameters>;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  encodeShaderParameters?: (parameters: ShaderParameters) => any;
}

interface ShaderContext {
  numChannelDimensions: number;
  dataHistogramChannelSpecifications: HistogramChannelSpecification[];
}

export abstract class SliceViewVolumeRenderLayer<
  ShaderParameters = any,
> extends SliceViewRenderLayer<VolumeChunkSource, VolumeSourceOptions> {
  multiscaleSource: MultiscaleVolumeChunkSource;
  protected shaderGetter: ParameterizedContextDependentShaderGetter<
    { chunkFormat: ChunkFormat },
    ShaderParameters,
    ShaderContext
  >;
  shaderParameters: WatchableValueInterface<ShaderParameters>;
  private vertexIdHelper: VertexIdHelper;

  constructor(
    multiscaleSource: MultiscaleVolumeChunkSource,
    options: RenderLayerOptions<ShaderParameters>,
  ) {
    const { shaderError = makeWatchableShaderError(), shaderParameters } =
      options;
    super(multiscaleSource.chunkManager, multiscaleSource, options);
    const { gl } = this;
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(gl));
    this.shaderParameters = shaderParameters;
    const { channelCoordinateSpace } = options;
    this.channelCoordinateSpace =
      channelCoordinateSpace === undefined
        ? constantWatchableValue(emptyInvalidCoordinateSpace)
        : channelCoordinateSpace;
    this.registerDisposer(
      shaderParameters.changed.add(this.redrawNeeded.dispatch),
    );
    // The shader depends on the `ChunkFormat` (which is a property of the `VolumeChunkSource`), the
    // `ShaderParameters` (which are determined by the derived RenderLayer class), the number of
    // channel dimensions, and the data histogram channel specifications.
    const extraParameters = this.registerDisposer(
      makeCachedDerivedWatchableValue(
        (
          space: CoordinateSpace,
          dataHistogramChannelSpecifications: HistogramChannelSpecification[],
        ) => ({
          numChannelDimensions: space.rank,
          dataHistogramChannelSpecifications,
        }),
        [
          this.channelCoordinateSpace,
          this.dataHistogramSpecifications.channels,
        ],
      ),
    );
    this.shaderGetter = parameterizedContextDependentShaderGetter(this, gl, {
      memoizeKey: `volume/RenderLayer:${getObjectId(this.constructor)}`,
      fallbackParameters: options.fallbackShaderParameters,
      parameters: shaderParameters,
      encodeParameters: options.encodeShaderParameters,
      shaderError,
      extraParameters,
      defineShader: (
        builder: ShaderBuilder,
        context: {
          chunkFormat: ChunkFormat | null;
        },
        parameters: ShaderParameters,
        extraParameters: ShaderContext,
      ) => {
        const { chunkFormat } = context;
        const { numChannelDimensions } =
          extraParameters;
        defineVolumeShader(builder, chunkFormat === null);
        builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
        builder.addFragmentCode(`
void emit(vec4 color) {
  v4f_fragData0 = color;
}
`);
        if (chunkFormat === null) {
          return;
        }
        defineChunkDataShaderAccess(
          builder,
          chunkFormat,
          numChannelDimensions,
          "vChunkPosition",
        );
        this.defineShader(builder, parameters);
      },
      getContextKey: (context) => `${context.chunkFormat?.shaderKey}`,
    });
    this.initializeCounterpart();
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  beginChunkFormat(
    sliceView: SliceView,
    chunkFormat: ChunkFormat | null,
    projectionParameters: ProjectionParameters,
  ): ParameterizedShaderGetterResult<ShaderParameters, ShaderContext> {
    const { gl } = this;
    const shaderResult = this.shaderGetter({ chunkFormat });
    const { shader, parameters, fallback } = shaderResult;
    if (shader !== null) {
      shader.bind();
      initializeShader(shader, projectionParameters, chunkFormat === null);
      if (chunkFormat !== null) {
        this.initializeShader(sliceView, shader, parameters, fallback);
        // FIXME: may need to fix wire frame rendering
        chunkFormat.beginDrawing(gl, shader);
      }
    }
    return shaderResult;
  }

  abstract initializeShader(
    sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
    fallback: boolean,
  ): void;

  abstract defineShader(
    builder: ShaderBuilder,
    parameters: ShaderParameters,
  ): void;

  endSlice(
    sliceView: SliceView,
    shader: ShaderProgram,
    parameters: ShaderParameters,
  ) {
    sliceView;
    shader;
    parameters;
  }

  draw(renderContext: SliceViewRenderContext) {
    const { sliceView } = renderContext;
    const layerInfo = sliceView.visibleLayers.get(this)!;
    const { visibleSources } = layerInfo;
    if (visibleSources.length === 0) {
      return;
    }

    const { projectionParameters, wireFrame } = renderContext;

    const { gl } = this;

    this.vertexIdHelper.enable();

    const chunkPosition = vec3.create();

    let shaderResult: ParameterizedShaderGetterResult<
      ShaderParameters,
      ShaderContext
    >;
    let shader: ShaderProgram | null = null;
    let prevChunkFormat: ChunkFormat | undefined | null;
    // Size of chunk (in voxels) in the "display" subspace of the chunk coordinate space.
    const chunkDataDisplaySize = vec3.create();

    const endShader = () => {
      if (shader === null) return;
      if (prevChunkFormat !== null) {
        prevChunkFormat!.endDrawing(gl, shader);
      }
      this.endSlice(sliceView, shader, shaderResult.parameters);
    };
    let newSource = true;
    for (const transformedSource of visibleSources) {
      const chunkLayout = getNormalizedChunkLayout(
        projectionParameters,
        transformedSource.chunkLayout,
      );
      const {
        chunkTransform: { channelToChunkDimensionIndices },
      } = transformedSource;
      const source = transformedSource.source as VolumeChunkSource;
      const { fixedPositionWithinChunk, chunkDisplayDimensionIndices } =
        transformedSource;
      for (const chunkDim of chunkDisplayDimensionIndices) {
        fixedPositionWithinChunk[chunkDim] = 0;
      }
      const chunkFormat = wireFrame ? null : source.chunkFormat;
      if (chunkFormat !== prevChunkFormat) {
        prevChunkFormat = chunkFormat;
        endShader();
        shaderResult = this.beginChunkFormat(
          sliceView,
          chunkFormat,
          projectionParameters,
        );
        shader = shaderResult.shader;
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
      if (chunkFormat !== null) {
        chunkFormat.beginSource(gl, shader);
      }
      newSource = true;
      let presentCount = 0;
      let notPresentCount = 0;
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
            setupChunkDataSize(gl, shader!, chunkDataDisplaySize);
          }
          const { chunkGridPosition } = chunk;
          for (let i = 0; i < 3; ++i) {
            const chunkDim = chunkDisplayDimensionIndices[i];
            chunkPosition[i] =
              chunkDim === -1 || chunkDim >= chunkRank
                ? 0
                : originalChunkSize[i] * chunkGridPosition[chunkDim];
          }
          if (chunkFormat !== null) {
            chunkFormat.bindChunk(
              gl,
              shader!,
              chunk,
              fixedPositionWithinChunk,
              chunkDisplayDimensionIndices,
              channelToChunkDimensionIndices,
              newSource,
            );
          }
          newSource = false;
          // view shader code here
          // console.log(shader);
          drawChunk(gl, shader!, chunkPosition, wireFrame);
          ++presentCount;
        } else {
          ++notPresentCount;
        }
      });
    }
    endShader();
  }
}
