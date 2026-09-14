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

import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
} from "#src/state/coordinate_transform.js";
import {
  emptyValidCoordinateSpace,
} from "#src/state/coordinate_transform.js";
import type {
  CachedWatchableValue,
  WatchableValueInterface,
} from "#src/state/trackable_value.js";
import {
  constantWatchableValue,
  makeCachedDerivedWatchableValue,
} from "#src/state/trackable_value.js";
import { arraysEqual } from "#src/util/array.js";
import type { ValueOrError } from "#src/util/error.js";
import { mat4 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";

/**
 * Specifies coordinate transform information for a RenderLayer.
 */
export interface RenderLayerTransform {
  /**
   * Rank of chunk/model/layer subspace used by this RenderLayer, including any additional `[0,1)`
   * padding dimensions.
   */
  rank: number;

  /**
   * Rank of chunk/model/layer space, excluding any padding dimensions.
   */
  unpaddedRank: number;

  /**
   * Specifies for each local user layer dimension the corresponding "render layer" dimension.  A
   * value of `-1` indicates there is no corresponding "render layer" dimension.  The combined
   * values of `localToRenderLayerDimensions` and `globalToRenderLayerDimensions` that are not `-1`
   * must be distinct and partition `[0, ..., rank)`, where `rank` is the rank of the "model"
   * coordinate space.
   */
  localToRenderLayerDimensions: readonly number[];

  /**
   * Specifies for each global dimension the corresponding "render layer" dimension.  A value of
   * `-1` indicates there is no corresponding "render layer" dimension.
   */
  globalToRenderLayerDimensions: readonly number[];

  /**
   * Specifies for each channel dimension the corresponding "render layer" dimension.  A value of
   * `-1` indicates there is no corresponding "render layer" dimension.
   */
  channelToRenderLayerDimensions: readonly number[];

  channelToModelDimensions: readonly number[];

  channelSpaceShape: Uint32Array;

  /**
   * Homogeneous transform from "model" coordinate space to "render layer" coordinate space.
   */
  modelToRenderLayerTransform: Float32Array;

  modelDimensionNames: readonly string[];
  layerDimensionNames: readonly string[];
}

export type RenderLayerTransformOrError = ValueOrError<RenderLayerTransform>;

export function getRenderLayerTransform(
  globalCoordinateSpace: CoordinateSpace,
  localCoordinateSpace: CoordinateSpace,
  modelToLayerTransform: CoordinateSpaceTransform,
  subsourceEntry:
    | {
        subsourceToModelSubspaceTransform: Float32Array;
        modelSubspaceDimensionIndices: readonly number[];
      }
    | undefined,
  channelCoordinateSpace: CoordinateSpace = emptyValidCoordinateSpace,
): RenderLayerTransformOrError {
  const {
    inputSpace: modelSpace,
    rank: fullRank,
    sourceRank,
    outputSpace: layerSpace,
    transform: oldTransform,
  } = modelToLayerTransform;

  return {
    rank: 3,
    unpaddedRank: 3,
    modelDimensionNames: ['z', 'y', 'x'],
    layerDimensionNames: ['z', 'y', 'x'],
    localToRenderLayerDimensions: [],
    globalToRenderLayerDimensions: [0, 1, 2],
    channelToRenderLayerDimensions: [],
    modelToRenderLayerTransform: oldTransform,
    channelToModelDimensions: [],
    channelSpaceShape: new Uint32Array(),
  };
}

export function renderLayerTransformsEqual(
  a: RenderLayerTransformOrError,
  b: RenderLayerTransformOrError,
) {
  if (a === b) return true;
  if (a.error !== undefined || b.error !== undefined) return false;
  return (
    arraysEqual(a.modelDimensionNames, b.modelDimensionNames) &&
    arraysEqual(a.layerDimensionNames, b.layerDimensionNames) &&
    arraysEqual(
      a.globalToRenderLayerDimensions,
      b.globalToRenderLayerDimensions,
    ) &&
    arraysEqual(
      a.localToRenderLayerDimensions,
      b.localToRenderLayerDimensions,
    ) &&
    arraysEqual(
      a.channelToRenderLayerDimensions,
      b.channelToRenderLayerDimensions,
    ) &&
    arraysEqual(a.modelToRenderLayerTransform, b.modelToRenderLayerTransform) &&
    arraysEqual(a.channelSpaceShape, b.channelSpaceShape)
  );
}

export function getWatchableRenderLayerTransform(
  globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>,
  localCoordinateSpace: WatchableValueInterface<CoordinateSpace>,
  modelToLayerTransform: WatchableValueInterface<CoordinateSpaceTransform>,
  subsourceEntry:
    | {
        subsourceToModelSubspaceTransform: Float32Array;
        modelSubspaceDimensionIndices: readonly number[];
      }
    | undefined,
  channelCoordinateSpace?: WatchableValueInterface<CoordinateSpace | undefined>,
): CachedWatchableValue<RenderLayerTransformOrError> {
  return makeCachedDerivedWatchableValue(
    (
      globalCoordinateSpace: CoordinateSpace,
      localCoordinateSpace: CoordinateSpace,
      modelToLayerTransform: CoordinateSpaceTransform,
      channelCoordinateSpace: CoordinateSpace | undefined,
    ) =>
      getRenderLayerTransform(
        globalCoordinateSpace,
        localCoordinateSpace,
        modelToLayerTransform,
        subsourceEntry,
        channelCoordinateSpace,
      ),
    [
      globalCoordinateSpace,
      localCoordinateSpace,
      modelToLayerTransform,
      channelCoordinateSpace === undefined
        ? constantWatchableValue(undefined)
        : channelCoordinateSpace,
    ],
    renderLayerTransformsEqual,
  );
}

export interface LayerDisplayDimensionMapping {
  /**
   * List of indices of layer dimensions that correspond to display dimensions.
   */
  layerDisplayDimensionIndices: number[];

  /**
   * Maps each display dimension index to the corresponding layer dimension index, or `-1`.
   */
  displayToLayerDimensionIndices: number[];
}

export interface ChunkChannelAccessParameters {
  channelSpaceShape: Uint32Array;

  /**
   * Equal to the values in `channelToChunkDimensionIndices` not equal to `-1`.
   */
  chunkChannelDimensionIndices: readonly number[];

  /**
   * Product of `modelTransform.channelSpaceShape`.
   */
  numChannels: number;

  /**
   * Row-major array of shape `[numChannels, chunkChannelDimensionIndices.length]`, specifies the
   * coordinates within the chunk channel dimensions corresponding to each flat channel index.
   */
  chunkChannelCoordinates: Uint32Array;
}

export interface ChunkTransformParameters extends ChunkChannelAccessParameters {
  modelTransform: RenderLayerTransform;
  chunkToLayerTransform: Float32Array;
  layerToChunkTransform: Float32Array;
  chunkToLayerTransformDet: number;
  /**
   * Maps channel dimension indices in the layer channel coordinate space to the corresponding chunk
   * dimension index, or `-1` if there is no correpsonding chunk dimension.
   */
  channelToChunkDimensionIndices: readonly number[];
  combinedGlobalLocalToChunkTransform: Float32Array;
  combinedGlobalLocalRank: number;
  layerRank: number;
}

export interface ChunkDisplayTransformParameters {
  modelTransform: RenderLayerTransform;
  chunkTransform: ChunkTransformParameters;
  displaySubspaceModelMatrix: mat4;
  displaySubspaceInvModelMatrix: mat4;
  chunkDisplayDimensionIndices: number[];
  numChunkDisplayDims: number;
}

export function getChunkTransformParameters(
  modelTransform: RenderLayerTransform,
  chunkToModelTransform?: Float32Array,
): ChunkTransformParameters {
  const layerRank = modelTransform.rank;
  let chunkToLayerTransform: Float32Array;
  if (chunkToModelTransform !== undefined) {
    chunkToLayerTransform = new Float32Array((layerRank + 1) * (layerRank + 1));
    matrix.multiply(
      chunkToLayerTransform,
      layerRank + 1,
      modelTransform.modelToRenderLayerTransform,
      layerRank + 1,
      chunkToModelTransform,
      layerRank + 1,
      layerRank + 1,
      layerRank + 1,
      layerRank + 1,
    );
  } else {
    chunkToLayerTransform = modelTransform.modelToRenderLayerTransform;
  }
  const layerToChunkTransform = new Float32Array((layerRank + 1) * (layerRank + 1));
  const det = matrix.inverse(
    layerToChunkTransform,
    layerRank + 1,
    chunkToLayerTransform,
    layerRank + 1,
    layerRank + 1,
  );
  const {
    globalToRenderLayerDimensions,
    localToRenderLayerDimensions,
    channelToRenderLayerDimensions,
  } = modelTransform;
  const globalRank = globalToRenderLayerDimensions.length;
  const localRank = localToRenderLayerDimensions.length;
  const combinedGlobalLocalRank = globalRank + localRank;

  // Compute `combinedGlobalLocalToChunkTransform`.
  const combinedGlobalLocalToChunkTransform = new Float32Array(
    (combinedGlobalLocalRank + 1) * layerRank,
  );

  const channelRank = channelToRenderLayerDimensions.length;
  const channelToChunkDimensionIndices = new Array<number>(channelRank);
  const chunkChannelDimensionIndices: number[] = [];
  for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
    channelToChunkDimensionIndices[channelDim] = -1;
  }
  const numChannels = 1;
  const { channelSpaceShape } = modelTransform;
  const chunkChannelRank = chunkChannelDimensionIndices.length;
  const chunkChannelCoordinates = new Uint32Array(numChannels * chunkChannelRank);
  return {
    layerRank: layerRank,
    modelTransform,
    chunkToLayerTransform,
    layerToChunkTransform,
    chunkToLayerTransformDet: det,
    combinedGlobalLocalRank,
    combinedGlobalLocalToChunkTransform,
    channelToChunkDimensionIndices,
    chunkChannelDimensionIndices,
    numChannels,
    chunkChannelCoordinates,
    channelSpaceShape,
  };
}

export function getChunkDisplayTransformParameters(
  chunkTransform: ChunkTransformParameters,
  layerDisplayDimensionMapping: LayerDisplayDimensionMapping,
): ChunkDisplayTransformParameters {
  const { chunkToLayerTransform, modelTransform } = chunkTransform;
  const rank = modelTransform.rank;
  const { layerDisplayDimensionIndices, displayToLayerDimensionIndices } =
    layerDisplayDimensionMapping;
  const numLayerDisplayDims = layerDisplayDimensionIndices.length;
  const chunkDisplayDimensionIndices = [0, 1, 2]
  // Compute "model matrix" (transform from the displayed subspace of the chunk space) to the global
  // display coordinate space.
  const displaySubspaceModelMatrix = mat4.create();
  for (let displayDim = 0; displayDim < 3; ++displayDim) {
    const layerDim = displayToLayerDimensionIndices[displayDim];
    if (layerDim === -1) continue;
    for (
      let chunkDisplayDimIndex = 0;
      chunkDisplayDimIndex < numLayerDisplayDims;
      ++chunkDisplayDimIndex
    ) {
      const chunkDim = chunkDisplayDimensionIndices[chunkDisplayDimIndex];
      displaySubspaceModelMatrix[chunkDisplayDimIndex * 4 + displayDim] =
        chunkToLayerTransform[chunkDim * (rank + 1) + layerDim];
    }
    displaySubspaceModelMatrix[12 + displayDim] =
      chunkToLayerTransform[rank * (rank + 1) + layerDim];
  }
  const displaySubspaceInvModelMatrix = mat4.create();
  mat4.invert(displaySubspaceInvModelMatrix, displaySubspaceModelMatrix);

  for (let i = chunkDisplayDimensionIndices.length; i < 3; ++i) {
    chunkDisplayDimensionIndices[i] = -1;
  }
  return {
    modelTransform: chunkTransform.modelTransform,
    chunkTransform,
    displaySubspaceModelMatrix,
    displaySubspaceInvModelMatrix,
    chunkDisplayDimensionIndices,
    numChunkDisplayDims: numLayerDisplayDims,
  };
}

