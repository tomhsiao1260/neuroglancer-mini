/**
 * @license
 * Copyright 2017 Google Inc.
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
 * @file Computes, in the vertex shader, the polygon where the slice plane cuts a chunk's box.
 *
 * Uses the approach of "A Vertex Program for Efficient Box-Plane Intersection" (Christof Rezk
 * Salama and Andreas Kolb, VMV 2005):
 * http://www.cg.informatik.uni-siegen.de/data/Publications/2005/rezksalamaVMV2005.pdf
 *
 * The polygon has at most 6 vertices.  Vertex `i` is the first intersection with the plane found
 * along 4 candidate box edges; which edges depends on the box corner nearest the viewer ("front"
 * vertex), so the edge table for that corner is loaded whenever the plane changes.
 */

import type { mat4 } from "#src/util/geom.js";
import { transformVectorByMat4Transpose, vec3 } from "#src/util/geom.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

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
export const vertexBasePositions = new Float32Array([
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
export const boundingBoxCrossSectionVertexIndices = (() => {
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
export function defineBoundingBoxCrossSectionShader(builder: ShaderBuilder) {
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
export function setBoundingBoxCrossSectionShaderViewportPlane(
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
