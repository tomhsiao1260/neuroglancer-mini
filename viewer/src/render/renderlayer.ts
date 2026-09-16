/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The render layer that draws the volume.  For each visible chunk it draws the polygon where
 * the cross-section plane cuts the chunk's box, colored by the chunk's data mapped to gray.  Its
 * worker counterpart (`SliceViewRenderLayerBackend`) receives the values used to choose chunks.
 */

import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  ProjectionParameters,
  TransformedSource,
} from "#src/render/base.js";
import { SLICEVIEW_RENDERLAYER_RPC_ID } from "#src/render/base.js";
import type { ChunkFormat } from "#src/render/chunk_format.js";
import type {
  MultiscaleVolumeChunkSource,
  SliceView,
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
const tempChunkDataSize = new Float32Array(3);

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
) {
  const { chunkLayout } = tsource;
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

  // Every chunk of a scale has the same size, since zarr pads the chunks at the upper edge of the
  // volume.  The volume may therefore end inside its last chunk along a dimension; the shader clips
  // the polygon to these bounds so that the padding is not drawn.
  const { chunkDataSize, lowerVoxelBound, upperVoxelBound } = tsource.source.spec;
  tempChunkDataSize.set(chunkDataSize);
  gl.uniform3fv(shader.uniform("uChunkDataSize"), tempChunkDataSize);
  gl.uniform3fv(shader.uniform("uLowerClipBound"), lowerVoxelBound);
  gl.uniform3fv(shader.uniform("uUpperClipBound"), upperVoxelBound);
}

// ---------------------------------------------------------------------------------------------------
// Gray level
// ---------------------------------------------------------------------------------------------------

// Range of values mapped onto [0, 1]: the full range of the integer types, and [0, 1] for float32.
const dataTypeRange: Record<DataType, [number, number]> = {
  [DataType.UINT8]: [0, 0xff],
  [DataType.UINT16]: [0, 0xffff],
  [DataType.FLOAT32]: [0, 1],
};

/**
 * Returns the code of `float normalized(value)`, which maps a data value from the range of its
 * data type onto [0, 1].
 */
function defineNormalized(builder: ShaderBuilder, dataType: DataType) {
  // [lower bound, 1 / (upper bound - lower bound)]
  builder.addUniform("vec2", "uLerpParams");
  const code = `
float normalized(${getShaderType(dataType)} inputValue) {
  float v = (float(toRaw(inputValue)) - uLerpParams[0]) * uLerpParams[1];
  return clamp(v, 0.0, 1.0);
}
`;
  return [dataTypeShaderDefinition[dataType], code];
}

function setNormalizedUniforms(shader: ShaderProgram, dataType: DataType) {
  const [lower, upper] = dataTypeRange[dataType];
  shader.gl.uniform2f(
    shader.uniform("uLerpParams"),
    lower,
    1 / (upper - lower),
  );
}

// ---------------------------------------------------------------------------------------------------
// Render layer
// ---------------------------------------------------------------------------------------------------

export interface ImageRenderLayerOptions {
  renderScaleTarget: WatchableValueInterface<number>;
}

export interface SliceViewRenderContext {
  sliceView: SliceView;
  projectionParameters: ProjectionParameters;
}

/**
 * Draws the volume in grayscale: the data value at each point, mapped from the full range of the
 * data type onto [0, 1].
 */
export class ImageRenderLayer extends RefCounted {
  rpcId: RpcId | null = null;
  chunkManager: ChunkManager;
  renderScaleTarget: WatchableValueInterface<number>;
  private vertexIdHelper: VertexIdHelper;
  // Built on first use: `undefined` until then, `null` if it failed to build.  All scales of the
  // volume have the same data type, so one shader draws them all.
  private shader: ShaderProgram | null | undefined;

  constructor(
    public multiscaleSource: MultiscaleVolumeChunkSource,
    options: ImageRenderLayerOptions,
  ) {
    super();
    this.chunkManager = multiscaleSource.chunkManager;
    this.renderScaleTarget = options.renderScaleTarget;
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(this.gl));
    this.registerDisposer(() => this.shader?.dispose());
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
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget),
      ).rpcId,
    });
    this.rpcId = sharedObject.rpcId;
  }

  private getShader(chunkFormat: ChunkFormat) {
    let { shader } = this;
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
        // Leave the shader null; nothing is drawn with it.
      }
      this.shader = shader;
    }
    return shader;
  }

  draw(renderContext: SliceViewRenderContext) {
    const { sliceView, projectionParameters } = renderContext;
    const { visibleSources } = sliceView;
    if (visibleSources.length === 0) {
      return;
    }

    const { gl } = this;
    const { chunkFormat } = visibleSources[0].source;
    const shader = this.getShader(chunkFormat);
    if (shader === null) {
      return;
    }

    this.vertexIdHelper.enable();
    shader.bind();
    setNormalizedUniforms(shader, this.dataType);
    chunkFormat.beginDrawing(gl);

    const chunkPosition = vec3.create();
    for (const transformedSource of visibleSources) {
      const { chunkLayout, source } = transformedSource;
      const chunks = source.chunks;
      const chunkSize = chunkLayout.size;

      beginSource(
        gl,
        shader,
        sliceView,
        projectionParameters.viewProjectionMat,
        transformedSource,
      );
      let newSource = true;
      sliceView.forEachVisibleChunk(transformedSource, (key) => {
        const chunk = chunks.get(key);
        if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
          const { chunkGridPosition } = chunk;
          for (let i = 0; i < 3; ++i) {
            chunkPosition[i] = chunkSize[i] * chunkGridPosition[i];
          }
          chunkFormat.bindChunk(gl, shader, chunk, newSource);
          newSource = false;
          gl.uniform3fv(shader.uniform("uTranslation"), chunkPosition);
          gl.drawArrays(gl.TRIANGLE_FAN, 0, 6);
        }
      });
    }
    chunkFormat.endDrawing(gl);
  }
}
