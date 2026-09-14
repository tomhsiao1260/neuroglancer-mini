/**
 * @license
 * Copyright 2019 Google Inc.
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

import type { DisplayDimensionRenderInfo } from "#src/state/navigation_state.js";
import { arraysEqual } from "#src/util/array.js";
import { mat4 } from "#src/util/geom.js";
import { kEmptyFloat32Vec } from "#src/util/vector.js";

export class RenderViewport {
  // Width of visible portion of panel in canvas pixels.
  width = 0;

  // Height of visible portion of panel in canvas pixels.
  height = 0;

  // Width in canvas pixels, including portions outside of the canvas (i.e. outside the "viewport"
  // window).
  logicalWidth = 0;

  // Height in canvas pixels, including portions outside of the canvas (i.e. outside the "viewport"
  // window).
  logicalHeight = 0;

  // Left edge of visible region within full (logical) panel, as fraction in [0, 1].
  visibleLeftFraction = 0;

  // Top edge of visible region within full (logical) panel, as fraction in [0, 1].
  visibleTopFraction = 0;

  // Fraction of logical width that is visible, equal to `widthInCanvasPixels / logicalWidth`.
  visibleWidthFraction = 0;

  // Fraction of logical height that is visible, equal to `heightInCanvasPixels / logicalHeight`.
  visibleHeightFraction = 0;
}

export function renderViewportsEqual(a: RenderViewport, b: RenderViewport) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.logicalWidth === b.logicalWidth &&
    a.logicalHeight === b.logicalHeight &&
    a.visibleLeftFraction === b.visibleLeftFraction &&
    a.visibleTopFraction === b.visibleTopFraction
  );
}

export class ProjectionParameters extends RenderViewport {
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;

  /**
   * Global position.
   */
  globalPosition: Float32Array = kEmptyFloat32Vec;

  /**
   * Transform from camera coordinates to OpenGL clip coordinates.
   */
  projectionMat: mat4 = mat4.create();

  /**
   * Transform from world coordinates to camera coordinates.
   */
  viewMatrix: mat4 = mat4.create();

  /**
   * Inverse of `viewMat`.
   */
  invViewMatrix: mat4 = mat4.create();

  /**
   * Transform from world coordinates to OpenGL clip coordinates.  Equal to:
   * `projectionMat * viewMat`.
   */
  viewProjectionMat: mat4 = mat4.create();

  /**
   * Inverse of `viewProjectionMat`.
   */
  invViewProjectionMat: mat4 = mat4.create();
}

export function projectionParametersEqual(
  a: ProjectionParameters,
  b: ProjectionParameters,
) {
  return (
    a.displayDimensionRenderInfo === b.displayDimensionRenderInfo &&
    renderViewportsEqual(a, b) &&
    arraysEqual(a.globalPosition, b.globalPosition) &&
    arraysEqual(a.projectionMat, b.projectionMat) &&
    arraysEqual(a.viewMatrix, b.viewMatrix)
  );
}

export function updateProjectionParametersFromInverseViewAndProjection(
  p: ProjectionParameters,
) {
  const { viewMatrix, viewProjectionMat } = p;
  mat4.invert(viewMatrix, p.invViewMatrix);
  mat4.multiply(viewProjectionMat, p.projectionMat, viewMatrix);
  mat4.invert(p.invViewProjectionMat, viewProjectionMat);
}
