/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The render layer that draws the volume.  For each visible chunk it draws the polygon where
 * the cross-section plane cuts the chunk's box, colored by the chunk's data mapped to gray.  Its
 * worker counterpart (`SliceViewRenderLayerBackend`) receives the values used to choose chunks.
 */

import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  ChunkLayout,
  SliceViewProjectionParameters,
  TransformedSource,
} from "#src/render/base.js";
import {
  filterVisibleSources,
  SLICEVIEW_RENDERLAYER_RPC_ID,
} from "#src/render/base.js";
import type { ChunkFormat } from "#src/render/chunk_format.js";
import type {
  MultiscaleVolumeChunkSource,
  SliceView,
  VolumeChunkSource,
} from "#src/render/frontend.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  mat4,
  transformVectorByMat4Transpose,
  vec3,
} from "#src/util/geom.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import {
  dataTypeShaderDefinition,
  getShaderType,
} from "#src/webgl/shader_lib.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type { RpcId } from "#src/worker/worker_rpc.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

// ---------------------------------------------------------------------------------------------------
// Box-plane intersection
//
// Computes, in the vertex shader, the polygon where the slice plane cuts a chunk's box, using the
// approach of "A Vertex Program for Efficient Box-Plane Intersection" (Christof Rezk Salama and
// Andreas Kolb, VMV 2005):
// http://www.cg.informatik.uni-siegen.de/data/Publications/2005/rezksalamaVMV2005.pdf
//
// The polygon has at most 6 vertices.  Vertex `i` is the first intersection with the plane found
// along 4 candidate box edges; which edges depends on the box corner nearest the viewer ("front"
// vertex), so the edge table for that corner is loaded whenever the plane changes.
// ---------------------------------------------------------------------------------------------------

const tempVec3 = vec3.create();
const tempVec3b = vec3.create();

/**
 * Amount by which a computed intersection point may lie outside the [0, 1] range and still be
 * considered valid.  This needs to be non-zero in order to avoid vertex placement artifacts.
 */
const LAMBDA_EPSILON = 1e-3;

/**
 * If the absolute value of the dot product of a cube edge direction and the viewport plane normal
 * is less than this value, intersections along that cube edge will be exluded.  This needs to be
 * non-zero in order to avoid vertex placement artifacts.
 */
const ORTHOGONAL_EPSILON = 1e-3;

// Positions of the 8 box corners; corner `i` has coordinate `(i >> axis) & 1` along each axis.
const vertexBasePositions = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
  1, 1, 0,
  0, 0, 1,
  1, 0, 1,
  0, 1, 1,
  1, 1, 1,
]);

/**
 * For each front vertex (8), for each polygon vertex (6), 4 candidate edges given as pairs of corner
 * indices: 8 * 6 * 4 * 2 entries.
 */
const boundingBoxCrossSectionVertexIndices = (() => {
  // The paper numbers the corners differently: its corners 3 and 5 are our corners 4 and 3.
  const vertexUncorrectedToCorrected = [0, 1, 2, 4, 5, 3, 6, 7];
  const vertexCorrectedToUncorrected = [0, 1, 2, 5, 3, 4, 6, 7];

  // Candidate edges for front vertex 0 (in the paper's numbering), page 666.
  const vertexBaseIndices = [
    0, 1, 1, 4, 4, 7, 4, 7,
    1, 5, 0, 1, 1, 4, 4, 7,
    0, 2, 2, 5, 5, 7, 5, 7,
    2, 6, 0, 2, 2, 5, 5, 7,
    0, 3, 3, 6, 6, 7, 6, 7,
    3, 4, 0, 3, 3, 6, 6, 7,
  ];

  // Row `p` renames the corners of `vertexBaseIndices` for front vertex `p` (paper's numbering).
  const vertexPermutation = [
    0, 1, 2, 3, 4, 5, 6, 7,
    1, 4, 5, 0, 3, 7, 2, 6,
    2, 6, 0, 5, 7, 3, 1, 4,
    3, 0, 6, 4, 1, 2, 7, 5,
    4, 3, 7, 1, 0, 6, 5, 2,
    5, 2, 1, 7, 6, 0, 4, 3,
    6, 7, 3, 2, 5, 4, 0, 1,
    7, 5, 4, 6, 2, 1, 3, 0,
  ];

  const vertexIndices = new Int32Array(8 * 8 * 6);
  for (let p = 0; p < 8; ++p) {
    for (let i = 0; i < vertexBaseIndices.length; ++i) {
      const vertexPermutationIndex =
        vertexCorrectedToUncorrected[p] * 8 + vertexBaseIndices[i];
      vertexIndices[p * 8 * 6 + i] =
        vertexUncorrectedToCorrected[vertexPermutation[vertexPermutationIndex]];
    }
  }
  return vertexIndices;
})();

/**
 * Defines `getBoundingBoxPlaneIntersectionVertexPosition(chunkSize, boxLower, lowerClipBound,
 * upperClipBound, vertexIndex)`, the position of polygon vertex `vertexIndex` where the plane set by
 * `setBoundingBoxCrossSectionShaderViewportPlane` cuts the box, clipped to the clip bounds.
 */
function defineBoundingBoxCrossSectionShader(builder: ShaderBuilder) {
  // Slice plane normal.
  builder.addUniform("highp vec3", "uPlaneNormal");

  // Distance from the origin to the slice plane.
  builder.addUniform("highp float", "uPlaneDistance");

  // [6x4] array of the corner index pairs of the 4 candidate edges of each polygon vertex.
  builder.addUniform("highp ivec2", "uVertexIndex", 24);

  // Base vertex positions.
  builder.addUniform("highp vec3", "uVertexBasePosition", 8);
  builder.addInitializer((shader) => {
    shader.gl.uniform3fv(
      shader.uniform("uVertexBasePosition"),
      vertexBasePositions,
    );
  });

  builder.addVertexCode(`
vec3 getBoundingBoxPlaneIntersectionVertexPosition(vec3 chunkSize, vec3 boxLower, vec3 lowerClipBound, vec3 upperClipBound, int vertexIndex) {
  for (int e = 0; e < 4; ++e) {
    highp ivec2 vidx = uVertexIndex[vertexIndex*4 + e];
    highp vec3 v1 = max(lowerClipBound, min(upperClipBound, chunkSize * uVertexBasePosition[vidx.x] + boxLower));
    highp vec3 v2 = max(lowerClipBound, min(upperClipBound, chunkSize * uVertexBasePosition[vidx.y] + boxLower));
    highp vec3 vDir = v2 - v1;
    highp float denom = dot(vDir, uPlaneNormal);
    if (abs(denom) > ${ORTHOGONAL_EPSILON}) {
      highp float lambda = (uPlaneDistance - dot(v1, uPlaneNormal)) / denom;
      if ((lambda >= -${LAMBDA_EPSILON}) && (lambda <= (1.0 + ${LAMBDA_EPSILON}))) {
        lambda = clamp(lambda, 0.0, 1.0);
        highp vec3 position = v1 + lambda * vDir;
        return position;
      }
    }
  }
  return vec3(0, 0, 0);
}
`);
}

/**
 * Sets the slice plane, given in global coordinates by its normal and a point on it, in the box
 * coordinates of `modelMatrix` (box to global).
 */
function setBoundingBoxCrossSectionShaderViewportPlane(
  shader: ShaderProgram,
  viewportNormalInGlobalCoordinates: vec3,
  viewportCenterPosition: vec3,
  modelMatrix: mat4,
  invModelMatrix: mat4,
) {
  const planeNormal = transformVectorByMat4Transpose(
    tempVec3,
    viewportNormalInGlobalCoordinates,
    modelMatrix,
  );
  vec3.normalize(planeNormal, planeNormal);
  const planeDistanceToOrigin = vec3.dot(
    vec3.transformMat4(tempVec3b, viewportCenterPosition, invModelMatrix),
    planeNormal,
  );
  const { gl } = shader;
  gl.uniform3fv(shader.uniform("uPlaneNormal"), planeNormal);
  gl.uniform1f(shader.uniform("uPlaneDistance"), planeDistanceToOrigin);

  // The front vertex is the corner with the largest coordinate along each axis where the normal is
  // negative.
  let frontVertexIndex = 0;
  for (let axis = 0; axis < 3; ++axis) {
    if (planeNormal[axis] < 0) {
      frontVertexIndex += 1 << axis;
    }
  }
  gl.uniform2iv(
    shader.uniform("uVertexIndex"),
    boundingBoxCrossSectionVertexIndices.subarray(
      frontVertexIndex * 48,
      (frontVertexIndex + 1) * 48,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// Volume shader
// ---------------------------------------------------------------------------------------------------

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
  tsource: TransformedSource,
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

// ---------------------------------------------------------------------------------------------------
// Gray level
// ---------------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------------
// Render layer
// ---------------------------------------------------------------------------------------------------

export interface ImageRenderLayerOptions {
  renderScaleTarget: WatchableValueInterface<number>;
  // Position within the local coordinate space.
  localPosition: WatchableValueInterface<Float32Array>;
}

export interface SliceViewRenderContext {
  sliceView: SliceView;
  projectionParameters: SliceViewProjectionParameters;
}

/**
 * Draws the volume in grayscale: the data value at each point, mapped from the full range of the
 * data type onto [0, 1].
 */
export class ImageRenderLayer extends RefCounted {
  rpcId: RpcId | null = null;
  chunkManager: ChunkManager;
  renderScaleTarget: WatchableValueInterface<number>;
  localPosition: WatchableValueInterface<Float32Array>;
  private vertexIdHelper: VertexIdHelper;
  // Shader for each chunk format, built on first use; `null` if it failed to build.
  private shaders = new Map<ChunkFormat, ShaderProgram | null>();

  constructor(
    public multiscaleSource: MultiscaleVolumeChunkSource,
    options: ImageRenderLayerOptions,
  ) {
    super();
    this.chunkManager = multiscaleSource.chunkManager;
    this.renderScaleTarget = options.renderScaleTarget;
    this.localPosition = options.localPosition;
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));
    this.registerDisposer(() => {
      for (const shader of this.shaders.values()) {
        shader?.dispose();
      }
    });
    this.initializeCounterpart();
  }

  getSources() {
    return this.multiscaleSource.getSources();
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  // Creates the worker counterpart (`SliceViewRenderLayerBackend`), sharing the values the worker
  // needs to choose chunks.
  private initializeCounterpart() {
    const sharedObject = this.registerDisposer(new SharedObject());
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = SLICEVIEW_RENDERLAYER_RPC_ID;
    sharedObject.initializeCounterpart(rpc, {
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget),
      ).rpcId,
    });
    this.rpcId = sharedObject.rpcId;
  }

  filterVisibleSources(
    sliceView: any,
    sources: readonly TransformedSource[],
  ): Iterable<TransformedSource> {
    return filterVisibleSources(sliceView, this, sources);
  }

  private getShader(chunkFormat: ChunkFormat) {
    let shader = this.shaders.get(chunkFormat);
    if (shader === undefined) {
      shader = null;
      try {
        const builder = new ShaderBuilder(this.gl);
        defineVolumeShader(builder);
        chunkFormat.defineShader(builder);
        builder.addFragmentCode(defineNormalized(builder, this.dataType));
        builder.setFragmentMain(`
  float value = normalized(getDataValue());
  emit(vec4(value, value, value, 1.0));
`);
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
      setNormalizedUniforms(shader, this.dataType);
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
