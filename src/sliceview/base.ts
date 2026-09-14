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

/**
 * @file Shared by the main thread and the worker: which scales of a volume to show for the current
 * zoom level (`filterVisibleSources`), and which chunks of a scale intersect the cross-section plane
 * (`forEachPlaneIntersectingVolumetricChunk`).
 */

import type { DisplayDimensionRenderInfo } from "#src/state/navigation_state.js";
import { ProjectionParameters } from "#src/render/projection_parameters.js";
import type { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import type {
  WatchableValueChangeInterface,
  WatchableValueInterface,
} from "#src/state/trackable_value.js";
import { DATA_TYPE_BYTES, DataType } from "#src/util/data_type.js";
import type { Disposable } from "#src/util/disposable.js";
import { isAABBIntersectingPlane, mat4, vec3 } from "#src/util/geom.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

export { DATA_TYPE_BYTES, DataType };

const tempMat4 = mat4.create();

export interface MultiscaleVolumetricDataRenderLayer {
  localPosition: WatchableValueInterface<Float32Array>;
  renderScaleTarget: WatchableValueInterface<number>;
}

/**
 * One scale of a volume, together with how its chunk grid sits in the view.
 */
export interface TransformedSource<
  RLayer extends MultiscaleVolumetricDataRenderLayer = SliceViewRenderLayer,
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> {
  renderLayer: RLayer;

  source: Source;

  /**
   * Approximate voxel size in each of the display dimensions.
   */
  effectiveVoxelSize: vec3;

  chunkLayout: ChunkLayout;

  /**
   * Arrays of length `rank` specifying the clip bounds (in voxels) for all dimensions.
   */
  lowerClipBound: Float32Array;
  upperClipBound: Float32Array;

  // Lower clip bound (in voxels) in the "display" subspace of the chunk coordinate space.
  lowerClipDisplayBound: vec3;
  // Upper clip bound (in voxels) in the "display" subspace of the chunk coordinate space.
  upperClipDisplayBound: vec3;

  // Lower bound (in chunks) within the "display" subspace of the chunk coordinate space.
  lowerChunkDisplayBound: vec3;
  // Upper bound (in chunks) within the "display" subspace of the chunk coordinate space.
  upperChunkDisplayBound: vec3;

  /**
   * Dimensions of the chunk corresponding to the 3 display dimensions of the slice view.
   */
  chunkDisplayDimensionIndices: number[];

  /**
   * Rank of "layer" space and the "chunk clip" space, which is >= rank of chunk space.
   */
  layerRank: number;

  /**
   * Transform from dimensions of layer space to dimensions of chunk space.
   *
   * Matrix has dimensions `(globalRank + localRank + 1) * layerRank`.
   *
   * Input space is `[global dimensions, local dimensions]`.  Output space is the "chunk clip"
   * coordinate space, in units of voxels.
   *
   */
  combinedGlobalLocalToChunkTransform: Float32Array;

  /**
   * When `computeVisibleChunks` invokes the `addChunk` callback, this is set to the position of the
   * chunk.
   */
  curPositionInChunks: Float32Array;

  fixedPositionWithinChunk: Uint32Array;
}

export interface SliceViewRenderLayer {
  /**
   * Current position of non-global layer dimensions.
   */
  localPosition: WatchableValueInterface<Float32Array>;
  renderScaleTarget: WatchableValueInterface<number>;

  filterVisibleSources(
    sliceView: any,
    sources: readonly TransformedSource[],
  ): Iterable<TransformedSource>;
}

export interface VisibleLayerSources<
  RLayer extends MultiscaleVolumetricDataRenderLayer,
  Source extends SliceViewChunkSource,
  Transformed extends TransformedSource<RLayer, Source>,
> {
  // Transformed sources of the layer, indexed by chunk layout and then by scale (finest first).
  allSources: Transformed[][];
  // Scales currently shown, ordered from finest to coarsest.
  visibleSources: Transformed[];
  displayDimensionRenderInfo: DisplayDimensionRenderInfo;
}

export class SliceViewProjectionParameters extends ProjectionParameters {
  /**
   * Normal vector of cross section in (non-isotropic) global voxel coordinates.
   */
  viewportNormalInGlobalCoordinates = vec3.create();

  centerDataPosition = vec3.create();

  /**
   * Size in physical units of a single pixel.
   */
  pixelSize = 0;
}

function visibleSourcesInvalidated(
  oldValue: SliceViewProjectionParameters,
  newValue: SliceViewProjectionParameters,
) {
  if (
    oldValue.displayDimensionRenderInfo !== newValue.displayDimensionRenderInfo
  )
    return true;
  if (oldValue.pixelSize !== newValue.pixelSize) return true;
  const { viewMatrix: oldViewMatrix } = oldValue;
  const { viewMatrix: newViewMatrix } = newValue;
  for (let i = 0; i < 12; ++i) {
    if (oldViewMatrix[i] !== newViewMatrix[i]) return true;
  }
  return false;
}

export class SliceViewBase<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
  RLayer extends SliceViewRenderLayer = SliceViewRenderLayer,
  Transformed extends TransformedSource<RLayer, Source> = TransformedSource<
    RLayer,
    Source
  >,
> extends SharedObject {
  visibleLayers = new Map<
    RLayer,
    VisibleLayerSources<RLayer, Source, Transformed>
  >();
  visibleSourcesStale = true;

  constructor(
    public projectionParameters: WatchableValueChangeInterface<SliceViewProjectionParameters>,
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

  /**
   * Computes the list of sources to use for each visible layer, based on the
   * current pixelSize.
   */
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    const curDisplayDimensionRenderInfo =
      this.projectionParameters.value.displayDimensionRenderInfo;

    const { visibleLayers } = this;
    for (const [
      renderLayer,
      { allSources, visibleSources, displayDimensionRenderInfo },
    ] of visibleLayers) {
      visibleSources.length = 0;
      if (
        displayDimensionRenderInfo !== curDisplayDimensionRenderInfo ||
        allSources.length === 0
      ) {
        continue;
      }
      // A zarr volume has a single chunk layout per scale.
      const sources = allSources[0];

      for (const source of renderLayer.filterVisibleSources(this, sources)) {
        visibleSources.push(source as Transformed);
      }
      // Reverse visibleSources list since we added sources from coarsest to finest resolution, but
      // we want them ordered from finest to coarsest.
      visibleSources.reverse();
    }
  }
}

/**
 * Generic specification for SliceView chunks specifying a layout and voxel size.
 */
export interface SliceViewChunkSpecification<
  ChunkDataSize extends Uint32Array | Float32Array = Uint32Array | Float32Array,
> {
  rank: number;

  /**
   * Size of chunk in voxels.
   */
  chunkDataSize: ChunkDataSize;

  /**
   * All valid chunks are in the range [lowerChunkBound, upperChunkBound).
   *
   * These are specified in units of chunks (not voxels).
   */
  lowerChunkBound: Float32Array;
  upperChunkBound: Float32Array;

  lowerVoxelBound: Float32Array;
  upperVoxelBound: Float32Array;
}

export function makeSliceViewChunkSpecification<
  ChunkDataSize extends Uint32Array | Float32Array,
>(
  options: SliceViewChunkSpecificationOptions<ChunkDataSize>,
): SliceViewChunkSpecification<ChunkDataSize> {
  const { rank, chunkDataSize, upperVoxelBound } = options;
  const { lowerVoxelBound = new Float32Array(rank) } = options;
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
  };
}

/**
 * Yields the scales to draw, from coarsest to finest: starts at the coarsest scale and keeps adding
 * finer scales while they get closer to the on-screen pixel size.  Finer scales are drawn on top,
 * and coarser ones fill in wherever finer chunks are not loaded yet.
 */
export function* filterVisibleSources(
  sliceView: any,
  renderLayer: SliceViewRenderLayer,
  sources: readonly TransformedSource[],
): Iterable<TransformedSource> {
  // Increase pixel size by a small margin.
  const pixelSize = sliceView.projectionParameters.value.pixelSize * 1.1;
  // At the smallest scale, all alternative sources must have the same voxel size, which is
  // considered to be the base voxel size.
  const smallestVoxelSize = sources[0].effectiveVoxelSize;

  const renderScaleTarget = renderLayer.renderScaleTarget.value;

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

/**
 * Common parameters for SliceView Chunks.
 */
export interface SliceViewChunkSpecificationBaseOptions {
  rank: number;

  /**
   * If not specified, defaults to an all-zero vector.  This determines lowerChunkBound.  If this is
   * not a multiple of chunkDataSize, then voxels at lower positions may still be requested.
   */
  lowerVoxelBound?: Float32Array;

  /**
   * Exclusive upper bound in "chunk" coordinate space, in voxels.  This determines upperChunkBound.
   */
  upperVoxelBound: Float32Array;
}

export interface SliceViewChunkSpecificationOptions<
  ChunkDataSize extends Uint32Array | Float32Array = Uint32Array | Float32Array,
> extends SliceViewChunkSpecificationBaseOptions {
  chunkDataSize: ChunkDataSize;
}

export interface SliceViewChunkSource<
  Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
> extends Disposable {
  spec: Spec;
}

export const SLICEVIEW_RPC_ID = "SliceView";
export const SLICEVIEW_RENDERLAYER_RPC_ID = "sliceview/RenderLayer";
export const SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID = "SliceView.addVisibleLayer";
export const SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID =
  "SliceView.removeVisibleLayer";

const tempVisibleVolumetricChunkLower = new Float32Array(3);
const tempVisibleVolumetricChunkUpper = new Float32Array(3);
const tempVisibleVolumetricModelViewProjection = mat4.create();
const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

// Recursively splits the chunk range `[lower, upper)` in half along its longest dimension, pruning
// halves that `predicate` rejects, and calls `callback` for each single chunk that remains.
function forEachVolumetricChunkWithinFrustrum<
  RLayer extends MultiscaleVolumetricDataRenderLayer,
>(
  clippingPlanes: Float32Array,
  transformedSource: TransformedSource<RLayer>,
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
  const { curPositionInChunks, chunkDisplayDimensionIndices } =
    transformedSource;

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
      curPositionInChunks[chunkDisplayDimensionIndices[0]] = lower[0];
      curPositionInChunks[chunkDisplayDimensionIndices[1]] = lower[1];
      curPositionInChunks[chunkDisplayDimensionIndices[2]] = lower[2];
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
export function forEachPlaneIntersectingVolumetricChunk<
  RLayer extends MultiscaleVolumetricDataRenderLayer,
>(
  projectionParameters: ProjectionParameters,
  transformedSource: TransformedSource<RLayer>,
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
