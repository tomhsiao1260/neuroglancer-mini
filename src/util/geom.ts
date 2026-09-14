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

import type { mat3 } from "gl-matrix";
import { mat4, quat, vec3, vec4 } from "gl-matrix";
import type { TypedArray } from "#src/util/array.js";

export { mat2, mat3, mat4, quat, vec2, vec3, vec4 } from "gl-matrix";

export const identityMat4 = mat4.create();

export const kOneVec = vec3.fromValues(1, 1, 1);

/**
 * Implements a one-to-one conversion from Vec3 to string, suitable for use a Map key.
 *
 * Specifically, returns the string representation of the 3 values separated by commas.
 */
export function vec3Key(x: ArrayLike<number>) {
  return `${x[0]},${x[1]},${x[2]}`;
}

/**
 * Transforms a vector `a` by a homogenous transformation matrix `m`.  The translation component of
 * `m` is ignored.
 */
export function transformVectorByMat4(out: vec3, a: vec3, m: mat4) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/**
 * Transforms a vector `a` by the transpose of a homogenous transformation matrix `m`.  The
 * translation component of `m` is ignored.
 */
export function transformVectorByMat4Transpose(out: vec3, a: vec3, m: mat4) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[4] * x + m[5] * y + m[6] * z;
  out[2] = m[8] * x + m[9] * y + m[10] * z;
  return out;
}

/**
 * Returns the value of `t` that minimizes `(p - (a + t * (b - a)))`.
 */
export function findClosestParameterizedLinePosition(
  a: Float32Array,
  b: Float32Array,
  p: Float32Array,
) {
  // http://mathworld.wolfram.com/Point-LineDistance3-Dimensional.html
  // Compute t: -dot(a-p, b-a) / |b - a|^2
  const rank = p.length;
  let denominator = 0;
  for (let i = 0; i < rank; ++i) {
    denominator += (a[i] - b[i]) ** 2;
  }
  let numerator = 0;
  for (let i = 0; i < rank; ++i) {
    const aValue = a[i];
    numerator -= (aValue - p[i]) * (b[i] - aValue);
  }
  return numerator / Math.max(denominator, 1e-6);
}

/**
 * Extracts the left, right, bottom, top, near, far clipping planes from `projectionMat`.
 * @param out Row-major array of shape `(6, 4)` specifying for each of the left, right, bottom, top,
 *     near, far clipping planes the `a`, `b`, `c`, `d` coefficients such that
 *     `0 < a * x + b * y + c * z + d` if the point `x, y, z` is inside the half-space of the
 * clipping plane.
 * @param m Projection matrix
 */
export function getFrustrumPlanes(out: Float32Array, m: mat4): Float32Array {
  // http://web.archive.org/web/20120531231005/http://crazyjoke.free.fr/doc/3D/plane%20extraction.pdf
  const m00 = m[0];
  const m10 = m[1];
  const m20 = m[2];
  const m30 = m[3];
  const m01 = m[4];
  const m11 = m[5];
  const m21 = m[6];
  const m31 = m[7];
  const m02 = m[8];
  const m12 = m[9];
  const m22 = m[10];
  const m32 = m[11];
  const m03 = m[12];
  const m13 = m[13];
  const m23 = m[14];
  const m33 = m[15];

  out[0] = m30 + m00; // left: a
  out[1] = m31 + m01; // left: b
  out[2] = m32 + m02; // left: c
  out[3] = m33 + m03; // left: d

  out[4] = m30 - m00; // right: a
  out[5] = m31 - m01; // right: b
  out[6] = m32 - m02; // right: c
  out[7] = m33 - m03; // right: d

  out[8] = m30 + m10; // bottom: a
  out[9] = m31 + m11; // bottom: b
  out[10] = m32 + m12; // bottom: c
  out[11] = m33 + m13; // bottom: d

  out[12] = m30 - m10; // top: a
  out[13] = m31 - m11; // top: b
  out[14] = m32 - m12; // top: c
  out[15] = m33 - m13; // top: d

  const nearA = m30 + m20; // near: a
  const nearB = m31 + m21; // near: b
  const nearC = m32 + m22; // near: c
  const nearD = m33 + m23; // near: d

  const farA = m30 - m20; // far: a
  const farB = m31 - m21; // far: b
  const farC = m32 - m22; // far: c
  const farD = m33 - m23; // far: d

  // Normalize near plane
  const nearNorm = Math.sqrt(nearA ** 2 + nearB ** 2 + nearC ** 2);
  out[16] = nearA / nearNorm;
  out[17] = nearB / nearNorm;
  out[18] = nearC / nearNorm;
  out[19] = nearD / nearNorm;

  // Also normalize far plane
  const farNorm = Math.sqrt(farA ** 2 + farB ** 2 + farC ** 2);
  out[20] = farA / farNorm;
  out[21] = farB / farNorm;
  out[22] = farC / farNorm;
  out[23] = farD / farNorm;

  return out;
}

/**
 * Checks whether the specified axis-aligned bounding box (AABB) intersects the view frustrum.
 *
 * @param clippingPlanes Array of length 24 specifying the clipping planes of the view frustrum, as
 *     computed by `getFrustrumPlanes`
 */
export function isAABBVisible(
  xLower: number,
  yLower: number,
  zLower: number,
  xUpper: number,
  yUpper: number,
  zUpper: number,
  clippingPlanes: Float32Array,
) {
  for (let i = 0; i < 6; ++i) {
    const a = clippingPlanes[i * 4];
    const b = clippingPlanes[i * 4 + 1];
    const c = clippingPlanes[i * 4 + 2];
    const d = clippingPlanes[i * 4 + 3];
    const sum =
      Math.max(a * xLower, a * xUpper) +
      Math.max(b * yLower, b * yUpper) +
      Math.max(c * zLower, c * zUpper) +
      d;
    if (sum < 0) {
      return false;
    }
  }
  return true;
}

export function isAABBIntersectingPlane(
  xLower: number,
  yLower: number,
  zLower: number,
  xUpper: number,
  yUpper: number,
  zUpper: number,
  clippingPlanes: Float32Array,
) {
  for (let i = 0; i < 4; ++i) {
    const a = clippingPlanes[i * 4];
    const b = clippingPlanes[i * 4 + 1];
    const c = clippingPlanes[i * 4 + 2];
    const d = clippingPlanes[i * 4 + 3];
    const sum =
      Math.max(a * xLower, a * xUpper) +
      Math.max(b * yLower, b * yUpper) +
      Math.max(c * zLower, c * zUpper) +
      d;
    if (sum < 0) {
      return false;
    }
  }
  {
    const i = 5;
    const a = clippingPlanes[i * 4];
    const b = clippingPlanes[i * 4 + 1];
    const c = clippingPlanes[i * 4 + 2];
    const d = clippingPlanes[i * 4 + 3];
    const maxSum =
      Math.max(a * xLower, a * xUpper) +
      Math.max(b * yLower, b * yUpper) +
      Math.max(c * zLower, c * zUpper);
    const minSum =
      Math.min(a * xLower, a * xUpper) +
      Math.min(b * yLower, b * yUpper) +
      Math.min(c * zLower, c * zUpper);
    const epsilon = Math.abs(d) * 1e-6;
    if (minSum > -d + epsilon || maxSum < -d - epsilon) return false;
  }
  return true;
}

export function getViewFrustrumDepthRange(projectionMat: mat4) {
  if (projectionMat[15] === 1) {
    // orthographic projection
    const depth = 2 / Math.abs(projectionMat[10]);
    return depth;
  }
  // perspective projection
  // a = (far + near) / (near - far);
  // b = 2 * far * near / (near - far);
  const a = projectionMat[10];
  const b = projectionMat[14];
  const near = (2 * b) / (2 * a - 2);
  const far = ((a - 1) * near) / (a + 1);
  const depth = Math.abs(far - near);
  return depth;
}

const tempVec3 = vec3.create();

