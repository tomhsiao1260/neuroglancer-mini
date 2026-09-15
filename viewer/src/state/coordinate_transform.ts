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

import { WatchableValue } from "#src/state/trackable_value.js";
import * as matrix from "#src/util/matrix.js";
import * as vector from "#src/util/vector.js";

export type DimensionId = number;

export interface CoordinateArray {
  // Indicates whether this coordinate array was specified explicitly, in which case it will be
  // encoded in the JSON representation.
  explicit: boolean;
  // Specifies the coordinates.  Must be montonically increasing integers.
  coordinates: number[];
  // Specifies the label for each coordinate in `coordinates`.
  labels: string[];
}

export interface CoordinateSpace {
  /**
   * If `true`, has been fully initialized (i.e. based on at least one data source).  If `false`,
   * may be partially initialized.
   */
  readonly valid: boolean;

  readonly rank: number;

  /**
   * Specifies the name of each dimension.
   */
  readonly names: readonly string[];

  readonly ids: readonly DimensionId[];

  /**
   * Timestamp of last user action that changed the name, scale, or unit of each dimension, or
   * `undefined` if there was no user action.
   */
  readonly timestamps: readonly number[];

  /**
   * Specifies the physical units corresponding to this dimension.  May be empty to indicate
   * unitless.
   */
  readonly units: readonly string[];

  /**
   * Specifies a scale for this dimension.
   */
  readonly scales: Float64Array;

  readonly bounds: CoordinateSpaceBounds;
  readonly boundingBoxes: readonly TransformedBoundingBox[];

  readonly coordinateArrays: (CoordinateArray | undefined)[];
}

export function makeCoordinateSpace(space: {
  readonly valid?: boolean;
  readonly names: readonly string[];
  readonly units: readonly string[];
  readonly scales: Float64Array;
  readonly rank?: number;
  readonly timestamps?: readonly number[];
  readonly ids?: readonly DimensionId[];
  readonly boundingBoxes?: readonly TransformedBoundingBox[];
  readonly bounds?: CoordinateSpaceBounds;
  readonly coordinateArrays?: (CoordinateArray | undefined)[];
}): CoordinateSpace {
  const { names, units, scales } = space;
  const {
    valid = true,
    rank = names.length,
    timestamps = names.map(() => Number.NEGATIVE_INFINITY),
    ids = names.map((_, i) => -i),
    boundingBoxes = [],
  } = space;
  const { coordinateArrays = new Array<CoordinateArray | undefined>(rank) } =
    space;

  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const bounds = { lowerBounds, upperBounds, voxelCenterAtIntegerCoordinates: new Array(rank).fill(true) };

  return {
    valid,
    rank,
    names,
    timestamps,
    ids,
    units,
    scales,
    boundingBoxes,
    bounds,
    coordinateArrays,
  };
}

export const emptyInvalidCoordinateSpace = makeCoordinateSpace({
  valid: false,
  names: [],
  units: [],
  scales: vector.kEmptyFloat64Vec,
  boundingBoxes: [],
});

export class TrackableCoordinateSpace extends WatchableValue<CoordinateSpace> {
  constructor() {
    super(emptyInvalidCoordinateSpace);
  }

  reset() {
    this.value = emptyInvalidCoordinateSpace;
  }
  restoreState(obj: any) {
    this.value = {
      boundingBoxes: [],
      bounds: {
        lowerBounds: new Float64Array(0),
        upperBounds: new Float64Array(0),
        voxelCenterAtIntegerCoordinates: new Array(0)
      },
      coordinateArrays: [],
      ids: [],
      names: [],
      rank: 0,
      scales: new Float64Array(0),
      timestamps: [],
      units: [],
      valid: false,
    }
  }
}

export interface BoundingBox {
  lowerBounds: Float64Array;
  upperBounds: Float64Array;
}

export interface CoordinateSpaceBounds extends BoundingBox {
  voxelCenterAtIntegerCoordinates: boolean[];
}

export function roundCoordinateToVoxelCenter(
  bounds: CoordinateSpaceBounds,
  dimIndex: number,
  coordinate: number,
) {
  if (bounds.voxelCenterAtIntegerCoordinates[dimIndex]) {
    coordinate = Math.round(coordinate);
  } else {
    coordinate = Math.floor(coordinate) + 0.5;
  }
  return coordinate;
}

// Clamps `coordinate` to `[lower, upper - 1]`.  This is intended to be used with
// `roundCoordinateToVoxelCenter`.  If not rounding, it may be desirable to instead
// clamp to `[lower upper]`.
export function clampCoordinateToBounds(
  bounds: CoordinateSpaceBounds,
  dimIndex: number,
  coordinate: number,
) {
  const upperBound = bounds.upperBounds[dimIndex];
  if (Number.isFinite(upperBound)) {
    coordinate = Math.min(coordinate, upperBound - 1);
  }

  const lowerBound = bounds.lowerBounds[dimIndex];
  if (Number.isFinite(lowerBound)) {
    coordinate = Math.max(coordinate, lowerBound);
  }
  return coordinate;
}

export function clampAndRoundCoordinateToVoxelCenter(
  bounds: CoordinateSpaceBounds,
  dimIndex: number,
  coordinate: number,
): number {
  coordinate = clampCoordinateToBounds(bounds, dimIndex, coordinate);
  return roundCoordinateToVoxelCenter(bounds, dimIndex, coordinate);
}

export function getCenterBound(lower: number, upper: number) {
  let x = (lower + upper) / 2;
  if (!Number.isFinite(x)) x = Math.min(Math.max(0, lower), upper);
  return x;
}

export function getBoundingBoxCenter(
  out: Float32Array,
  bounds: BoundingBox,
): Float32Array {
  const { lowerBounds, upperBounds } = bounds;
  const rank = out.length;
  for (let i = 0; i < rank; ++i) {
    out[i] = getCenterBound(lowerBounds[i], upperBounds[i]);
  }
  return out;
}

export function computeCombinedLowerUpperBound(
  boundingBox: TransformedBoundingBox,
  outputDimension: number,
  outputRank: number,
): { lower: number; upper: number } | undefined {
  const {
    box: { lowerBounds: baseLowerBounds, upperBounds: baseUpperBounds },
    transform,
  } = boundingBox;
  const inputRank = baseLowerBounds.length;
  const stride = outputRank;
  const offset = transform[stride * inputRank + outputDimension];
  let targetLower = offset;
  let targetUpper = offset;
  let hasCoefficient = false;
  for (let inputDim = 0; inputDim < inputRank; ++inputDim) {
    const c = transform[stride * inputDim + outputDimension];
    if (c === 0) continue;
    const lower = c * baseLowerBounds[inputDim];
    const upper = c * baseUpperBounds[inputDim];
    targetLower += Math.min(lower, upper);
    targetUpper += Math.max(lower, upper);
    hasCoefficient = true;
  }
  if (!hasCoefficient) return undefined;
  return { lower: targetLower, upper: targetUpper };
}

const INTEGER_BOUNDS_EPSILON = 1e-3;

export function computeCombinedBounds(
  boundingBoxes: readonly TransformedBoundingBox[],
  outputRank: number,
): CoordinateSpaceBounds {
  const lowerBounds = new Float64Array(outputRank);
  const upperBounds = new Float64Array(outputRank);
  lowerBounds.fill(Number.NEGATIVE_INFINITY);
  upperBounds.fill(Number.POSITIVE_INFINITY);

  // Number of bounding boxes for which both lower and upper bound has a fractional part of `0.5`.
  const halfIntegerBounds = new Array<number>(outputRank);
  halfIntegerBounds.fill(0);

  // Number of bounding boxes for which both lower and upper bound has a fractional part of `0.0`.
  const integerBounds = new Array<number>(outputRank);
  integerBounds.fill(0);

  for (const boundingBox of boundingBoxes) {
    for (let outputDim = 0; outputDim < outputRank; ++outputDim) {
      const result = computeCombinedLowerUpperBound(
        boundingBox,
        outputDim,
        outputRank,
      );
      if (result === undefined) continue;
      let { lower: targetLower, upper: targetUpper } = result;
      if (Number.isFinite(targetLower) && Number.isFinite(targetUpper)) {
        let lowerRound: number;
        let upperRound: number;
        let lowerFloor: number;
        let upperFloor: number;
        if (
          Math.abs(targetLower - (lowerRound = Math.round(targetLower))) <
            INTEGER_BOUNDS_EPSILON &&
          Math.abs(targetUpper - (upperRound = Math.round(targetUpper))) <
            INTEGER_BOUNDS_EPSILON
        ) {
          ++integerBounds[outputDim];
          targetLower = lowerRound;
          targetUpper = upperRound;
        } else if (
          Math.abs(targetLower - (lowerFloor = Math.floor(targetLower)) - 0.5) <
            INTEGER_BOUNDS_EPSILON &&
          Math.abs(targetUpper - (upperFloor = Math.floor(targetUpper)) - 0.5) <
            INTEGER_BOUNDS_EPSILON
        ) {
          ++halfIntegerBounds[outputDim];
          targetLower = lowerFloor + 0.5;
          targetUpper = upperFloor + 0.5;
        }
      }
      lowerBounds[outputDim] =
        lowerBounds[outputDim] === Number.NEGATIVE_INFINITY
          ? targetLower
          : Math.min(lowerBounds[outputDim], targetLower);
      upperBounds[outputDim] =
        upperBounds[outputDim] === Number.POSITIVE_INFINITY
          ? targetUpper
          : Math.max(upperBounds[outputDim], targetUpper);
    }
  }

  const voxelCenterAtIntegerCoordinates = integerBounds.map(
    (integerCount, i) => {
      const halfIntegerCount = halfIntegerBounds[i];
      // If all bounding boxes have half-integer bounds, assume voxel center is at integer
      // coordinates.  Otherwise, assume voxel center is at half-integer coordinates.
      return halfIntegerCount > 0 && integerCount === 0;
    },
  );
  return { lowerBounds, upperBounds, voxelCenterAtIntegerCoordinates };
}

export interface TransformedBoundingBox {
  box: BoundingBox;

  /**
   * Transform from "box" coordinate space to target coordinate space.
   */
  transform: Float64Array;
}

export function makeIdentityTransformedBoundingBox(box: BoundingBox) {
  const rank = box.lowerBounds.length;
  return {
    box,
    transform: matrix.createIdentity(Float64Array, rank, rank + 1),
  };
}

/**
 * Returns the 3-d (z, y, x) viewer coordinate space covering the bounding boxes of `space`.  With
 * the half-voxel offset of OME-Zarr, a volume of shape `n` spans `[-0.5, n - 0.5]` and voxel
 * centers are at integer coordinates.
 */
export function makeCombinedCoordinateSpace(
  space: CoordinateSpace,
): CoordinateSpace {
  const bounds = computeCombinedBounds(space.boundingBoxes, 3);
  return {
    boundingBoxes: [
      {
        box: bounds,
        transform: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      },
    ],
    bounds,
    coordinateArrays: new Array(3),
    ids: [1, 2, 3],
    names: ["z", "y", "x"],
    rank: 3,
    scales: new Float64Array([1, 1, 1]),
    timestamps: [-Infinity, -Infinity, -Infinity],
    units: ["", "", ""],
    valid: true,
  };
}


