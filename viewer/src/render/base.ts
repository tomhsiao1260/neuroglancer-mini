/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Shared by the main thread and the worker: a panel's projection (`ProjectionParameters`), the
 * chunk grid of a scale in view coordinates (`ChunkLayout`), which scales of a volume to show for
 * the current zoom level (`filterVisibleSources`), and which chunks of a scale intersect the
 * cross-section plane (`forEachPlaneIntersectingVolumetricChunk`).
 */

import type {
  WatchableValueChangeInterface,
  WatchableValueInterface,
} from "#src/state/trackable_value.js";
import { arraysEqual } from "#src/util/array.js";
import type { DataType } from "#src/util/data_type.js";
import type { Disposable } from "#src/util/disposable.js";
import {
  isAABBIntersectingPlane,
  mat4,
  transformVectorByMat4,
  vec3,
} from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import { kEmptyFloat32Vec } from "#src/util/vector.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

const tempMat4 = mat4.create();

export const PROJECTION_PARAMETERS_RPC_ID = "SharedProjectionParameters";
export const PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID =
  "SharedProjectionParameters.changed";

// The size of a panel, in canvas pixels.
export class RenderViewport {
  width = 0;
  height = 0;
}

export function renderViewportsEqual(a: RenderViewport, b: RenderViewport) {
  return a.width === b.width && a.height === b.height;
}

/**
 * A panel's viewport and camera: `invViewMatrix` places the view (in screen pixels, centered on the
 * panel) in voxel coordinates, and `projectionMat` maps it to clip coordinates.  The worker receives
 * a copy to choose chunks.
 */
export class ProjectionParameters extends RenderViewport {
  // Position of the center of the view, in voxels; empty until the volume has loaded.
  globalPosition: Float32Array = kEmptyFloat32Vec;

  // Transform from view coordinates to clip coordinates.
  projectionMat: mat4 = mat4.create();

  // Transform from voxel coordinates to view coordinates.
  viewMatrix: mat4 = mat4.create();

  // Inverse of `viewMatrix`.
  invViewMatrix: mat4 = mat4.create();

  // Transform from voxel coordinates to clip coordinates: `projectionMat * viewMatrix`.
  viewProjectionMat: mat4 = mat4.create();

  // Normal of the cross-section plane, in voxel coordinates.
  viewportNormalInGlobalCoordinates = vec3.create();

  centerDataPosition = vec3.create();

  // Size of a screen pixel, in voxels of the full-resolution scale.
  pixelSize = 0;
}

export function projectionParametersEqual(
  a: ProjectionParameters,
  b: ProjectionParameters,
) {
  return (
    renderViewportsEqual(a, b) &&
    arraysEqual(a.globalPosition, b.globalPosition) &&
    arraysEqual(a.projectionMat, b.projectionMat) &&
    arraysEqual(a.viewMatrix, b.viewMatrix)
  );
}

/**
 * Regular grid of chunks: every chunk has size `size` in chunk coordinates, and `transform` maps
 * chunk coordinates to global voxel coordinates.
 */
export class ChunkLayout {
  /**
   * Size of each chunk in "chunk" coordinates.
   */
  size: vec3;

  /**
   * Transform from local "chunk" coordinates to global voxel coordinates.
   */
  transform: mat4;

  /**
   * Inverse of transform.  Transform from global voxel coordinates to "chunk" coordinates.
   */
  invTransform: mat4;

  constructor(size: vec3, transform: mat4) {
    this.size = vec3.clone(size);
    this.transform = mat4.clone(transform);
    const invTransform = mat4.create();
    const det = matrix.inverse(invTransform, 4, transform, 4, 4);
    if (det === 0) {
      throw new Error("Transform is singular");
    }
    this.invTransform = invTransform;
  }

  toObject() {
    return {
      size: this.size,
      transform: this.transform,
    };
  }

  static fromObject(msg: any) {
    return new ChunkLayout(msg.size, msg.transform);
  }

  /**
   * Transform global spatial coordinates to local spatial coordinates.
   */
  globalToLocalSpatial(out: vec3, globalSpatial: vec3): vec3 {
    return vec3.transformMat4(out, globalSpatial, this.invTransform);
  }

  localSpatialVectorToGlobal(out: vec3, localVector: vec3): vec3 {
    return transformVectorByMat4(out, localVector, this.transform);
  }
}

/**
 * One scale of a volume, together with how its chunk grid sits in the view.
 */
export interface TransformedSource<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> {
  source: Source;

  /**
   * Approximate voxel size in each of the display dimensions.
   */
  effectiveVoxelSize: vec3;

  chunkLayout: ChunkLayout;

  // Lower clip bound (in voxels) in the "display" subspace of the chunk coordinate space.
  lowerClipDisplayBound: vec3;
  // Upper clip bound (in voxels) in the "display" subspace of the chunk coordinate space.
  upperClipDisplayBound: vec3;

  // Lower bound (in chunks) within the "display" subspace of the chunk coordinate space.
  lowerChunkDisplayBound: vec3;
  // Upper bound (in chunks) within the "display" subspace of the chunk coordinate space.
  upperChunkDisplayBound: vec3;

  // While `forEachPlaneIntersectingVolumetricChunk` calls its callback, the position of the chunk in
  // the chunk grid.
  curPositionInChunks: Float32Array;
}

function visibleSourcesInvalidated(
  oldValue: ProjectionParameters,
  newValue: ProjectionParameters,
) {
  if (oldValue.pixelSize !== newValue.pixelSize) return true;
  const { viewMatrix: oldViewMatrix } = oldValue;
  const { viewMatrix: newViewMatrix } = newValue;
  for (let i = 0; i < 12; ++i) {
    if (oldViewMatrix[i] !== newViewMatrix[i]) return true;
  }
  return false;
}

/**
 * What both sides of a cross-section view keep: the scales of the volume placed in the view, and
 * the scales currently shown.
 */
export class SliceViewBase<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> extends SharedObject {
  // One transformed source per scale, finest first; empty until the volume has loaded.
  sources: TransformedSource<Source>[] = [];
  // Scales to draw and to load, ordered from finest to coarsest.
  visibleSources: TransformedSource<Source>[] = [];
  // Preferred voxel size of the shown scales, in screen pixels; set together with `sources`.
  renderScaleTarget: WatchableValueInterface<number> | undefined;
  visibleSourcesStale = true;

  constructor(
    public projectionParameters: WatchableValueChangeInterface<ProjectionParameters>,
  ) {
    super();
    this.registerDisposer(
      projectionParameters.changed.add((oldValue, newValue) => {
        if (visibleSourcesInvalidated(oldValue, newValue)) {
          this.invalidateVisibleSources();
        }
        this.invalidateVisibleChunks();
      }),
    );
  }

  invalidateVisibleSources() {
    this.visibleSourcesStale = true;
  }

  invalidateVisibleChunks() {}

  // Chooses the scales to show for the current pixel size (see `filterVisibleSources`).
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    const { sources, visibleSources, renderScaleTarget } = this;
    visibleSources.length = 0;
    if (sources.length === 0 || renderScaleTarget === undefined) {
      return;
    }
    for (const source of filterVisibleSources(
      this.projectionParameters.value.pixelSize,
      renderScaleTarget.value,
      sources,
    )) {
      visibleSources.push(source);
    }
    // `filterVisibleSources` yields the coarsest scale first; list the finest first.
    visibleSources.reverse();
  }
}

/**
 * The chunk grid of one scale, in its chunk space (x, y, z voxels): chunks of `chunkDataSize` voxels
 * covering `[lowerVoxelBound, upperVoxelBound)`.
 */
export interface VolumeChunkSpecification {
  rank: number;
  // Size of a chunk, in voxels.
  chunkDataSize: Uint32Array;
  // All chunks are in the range [lowerChunkBound, upperChunkBound), in chunks.
  lowerChunkBound: Float32Array;
  upperChunkBound: Float32Array;
  lowerVoxelBound: Float32Array;
  upperVoxelBound: Float32Array;
  dataType: DataType;
}

// Returns the grid of chunks of `chunkDataSize` voxels covering `[0, upperVoxelBound)`.
export function makeVolumeChunkSpecification(options: {
  rank: number;
  dataType: DataType;
  chunkDataSize: Uint32Array;
  upperVoxelBound: Float32Array;
}): VolumeChunkSpecification {
  const { rank, dataType, chunkDataSize, upperVoxelBound } = options;
  const lowerVoxelBound = new Float32Array(rank);
  const lowerChunkBound = new Float32Array(rank);
  const upperChunkBound = new Float32Array(rank);
  for (let i = 0; i < rank; ++i) {
    lowerChunkBound[i] = Math.floor(lowerVoxelBound[i] / chunkDataSize[i]);
    upperChunkBound[i] = Math.floor(
      (upperVoxelBound[i] - 1) / chunkDataSize[i] + 1,
    );
  }
  return {
    rank,
    chunkDataSize,
    lowerChunkBound,
    upperChunkBound,
    lowerVoxelBound,
    upperVoxelBound,
    dataType,
  };
}

/**
 * Yields the scales to draw, from coarsest to finest: starts at the coarsest scale and keeps adding
 * finer scales while they get closer to the on-screen pixel size.  Finer scales are drawn on top,
 * and coarser ones fill in wherever finer chunks are not loaded yet.
 */
export function* filterVisibleSources<T extends TransformedSource<any>>(
  pixelSize: number,
  renderScaleTarget: number,
  sources: readonly T[],
): Iterable<T> {
  // Increase pixel size by a small margin.
  pixelSize *= 1.1;
  // The voxel size of the finest scale is the base voxel size.
  const smallestVoxelSize = sources[0].effectiveVoxelSize;

  /**
   * Determines whether we should continue to look for a finer-resolution source *after* one
   * with the specified voxelSize.
   */
  const canImproveOnVoxelSize = (voxelSize: vec3) => {
    const targetSize = pixelSize * renderScaleTarget;
    for (let i = 0; i < 3; ++i) {
      const size = voxelSize[i];
      // If size <= pixelSize, no need for improvement.
      // If size === smallestVoxelSize, also no need for improvement.
      if (size > targetSize && size > 1.01 * smallestVoxelSize[i]) {
        return true;
      }
    }
    return false;
  };

  const improvesOnPrevVoxelSize = (voxelSize: vec3, prevVoxelSize: vec3) => {
    const targetSize = pixelSize * renderScaleTarget;
    for (let i = 0; i < 3; ++i) {
      const size = voxelSize[i];
      const prevSize = prevVoxelSize[i];
      if (
        Math.abs(targetSize - size) < Math.abs(targetSize - prevSize) &&
        size < 1.01 * prevSize
      ) {
        return true;
      }
    }
    return false;
  };
  let scaleIndex = sources.length - 1;
  let prevVoxelSize: vec3 | undefined;
  while (true) {
    const transformedSource = sources[scaleIndex];
    if (
      prevVoxelSize !== undefined &&
      !improvesOnPrevVoxelSize(
        transformedSource.effectiveVoxelSize,
        prevVoxelSize,
      )
    ) {
      break;
    }
    yield transformedSource;

    if (
      scaleIndex === 0 ||
      !canImproveOnVoxelSize(transformedSource.effectiveVoxelSize)
    ) {
      break;
    }
    prevVoxelSize = transformedSource.effectiveVoxelSize;
    --scaleIndex;
  }
}

// What both threads' chunk sources (`VolumeChunkSource` in `frontend.ts` and `backend.ts`) have.
export interface SliceViewChunkSource extends Disposable {
  spec: VolumeChunkSpecification;
}

export const SLICEVIEW_RPC_ID = "SliceView";
export const SLICEVIEW_RENDERLAYER_RPC_ID = "sliceview/RenderLayer";
// Sends the render layer and its sources from a view to the view's worker counterpart.
export const SLICEVIEW_SET_LAYER_RPC_ID = "SliceView.setLayer";

const tempVisibleVolumetricChunkLower = new Float32Array(3);
const tempVisibleVolumetricChunkUpper = new Float32Array(3);
const tempVisibleVolumetricModelViewProjection = mat4.create();
const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

// Recursively splits the chunk range `[lower, upper)` in half along its longest dimension, pruning
// halves that `predicate` rejects, and calls `callback` for each single chunk that remains.
function forEachVolumetricChunkWithinFrustrum(
  clippingPlanes: Float32Array,
  transformedSource: TransformedSource<any>,
  callback: (positionInChunks: vec3, clippingPlanes: Float32Array) => void,
  predicate: (
    xLower: number,
    yLower: number,
    zLower: number,
    xUpper: number,
    yUpper: number,
    zUpper: number,
    clippingPlanes: Float32Array,
  ) => boolean,
) {
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  const { lowerChunkDisplayBound, upperChunkDisplayBound } = transformedSource;
  for (let i = 0; i < 3; ++i) {
    lower[i] = Math.max(lower[i], lowerChunkDisplayBound[i]);
    upper[i] = Math.min(upper[i], upperChunkDisplayBound[i]);
  }
  const { curPositionInChunks } = transformedSource;

  function recurse() {
    if (
      !predicate(
        lower[0],
        lower[1],
        lower[2],
        upper[0],
        upper[1],
        upper[2],
        clippingPlanes,
      )
    ) {
      return;
    }

    let splitDim = 0;
    let splitSize = Math.max(0, upper[0] - lower[0]);
    let volume = splitSize;
    for (let i = 1; i < 3; ++i) {
      const size = Math.max(0, upper[i] - lower[i]);
      volume *= size;
      if (size > splitSize) {
        splitSize = size;
        splitDim = i;
      }
    }
    if (volume === 0) return;
    if (volume === 1) {
      curPositionInChunks.set(lower);
      callback(lower as vec3, clippingPlanes);
      return;
    }
    const prevLower = lower[splitDim];
    const prevUpper = upper[splitDim];
    const splitPoint = Math.floor(0.5 * (prevLower + prevUpper));
    upper[splitDim] = splitPoint;
    recurse();
    upper[splitDim] = prevUpper;
    lower[splitDim] = splitPoint;
    recurse();
    lower[splitDim] = prevLower;
  }
  recurse();
}

/**
 * Calls `callback` for each chunk of `transformedSource` intersected by the cross-section plane
 * within the viewport.  `transformedSource.curPositionInChunks` holds the chunk position during the
 * call.
 */
export function forEachPlaneIntersectingVolumetricChunk(
  projectionParameters: ProjectionParameters,
  transformedSource: TransformedSource<any>,
  chunkLayout: ChunkLayout,
  callback: (positionInChunks: vec3) => void,
) {
  const { size: chunkSize } = chunkLayout;
  const modelViewProjection = mat4.multiply(
    tempVisibleVolumetricModelViewProjection,
    projectionParameters.viewProjectionMat,
    chunkLayout.transform,
  );
  for (let i = 0; i < 3; ++i) {
    const s = chunkSize[i];
    for (let j = 0; j < 4; ++j) {
      modelViewProjection[4 * i + j] *= s;
    }
  }

  const invModelViewProjection = tempMat4;
  mat4.invert(invModelViewProjection, modelViewProjection);
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  const epsilon = 1e-3;
  for (let i = 0; i < 3; ++i) {
    // Add small offset of `epsilon` voxels to bias towards the higher coordinate if very close to a
    // voxel boundary.
    const c = invModelViewProjection[12 + i] + epsilon / chunkSize[i];
    const xCoeff = Math.abs(invModelViewProjection[i]);
    const yCoeff = Math.abs(invModelViewProjection[4 + i]);
    lower[i] = Math.floor(c - xCoeff - yCoeff);
    upper[i] = Math.floor(c + xCoeff + yCoeff + 1);
  }

  const clippingPlanes = tempVisibleVolumetricClippingPlanes;
  for (let i = 0; i < 3; ++i) {
    const xCoeff = modelViewProjection[4 * i];
    const yCoeff = modelViewProjection[4 * i + 1];
    const zCoeff = modelViewProjection[4 * i + 2];
    clippingPlanes[i] = xCoeff;
    clippingPlanes[4 + i] = -xCoeff;
    clippingPlanes[8 + i] = +yCoeff;
    clippingPlanes[12 + i] = -yCoeff;
    clippingPlanes[16 + i] = +zCoeff;
    clippingPlanes[20 + i] = -zCoeff;
  }
  {
    const i = 3;
    const xCoeff = modelViewProjection[4 * i];
    const yCoeff = modelViewProjection[4 * i + 1];
    const zCoeff = modelViewProjection[4 * i + 2];
    clippingPlanes[i] = 1 + xCoeff;
    clippingPlanes[4 + i] = 1 - xCoeff;
    clippingPlanes[8 + i] = 1 + yCoeff;
    clippingPlanes[12 + i] = 1 - yCoeff;
    clippingPlanes[16 + i] = zCoeff;
    clippingPlanes[20 + i] = -zCoeff;
  }
  forEachVolumetricChunkWithinFrustrum(
    clippingPlanes,
    transformedSource,
    callback,
    isAABBIntersectingPlane,
  );
}
