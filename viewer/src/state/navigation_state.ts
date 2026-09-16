/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type {
  CoordinateSpace,
} from "#src/state/coordinate_transform.js";
import {
  clampAndRoundCoordinateToVoxelCenter,
  getBoundingBoxCenter,
} from "#src/state/coordinate_transform.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

const tempVec3 = vec3.create();

export class Position extends RefCounted {
  private coordinates_: Float32Array = new Float32Array(3);
  changed = new NullarySignal();

  constructor(
    public coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    super();

    this.registerDisposer(
      coordinateSpace.changed.add(() => {
        this.handleCoordinateSpaceChanged();
      }),
    );
  }

  get valid() {
    return this.coordinateSpace.value.valid;
  }

  /**
   * Returns the position in voxels.
   */
  get value() {
    return this.coordinates_;
  }

  private handleCoordinateSpaceChanged() {
    const coordinateSpace = this.coordinateSpace.value;
    if (!coordinateSpace.valid) return;
    const { bounds } = coordinateSpace;
    getBoundingBoxCenter(this.coordinates_, bounds);
    for (let i = 0; i < 3; ++i) {
        this.coordinates_[i] = Math.floor(this.coordinates_[i]) + 0.5;
      // }
    }
    this.changed.dispatch();
  }
}

export interface DisplayDimensionRenderInfo {
  /**
   * Number of global dimensions.
   */
  globalRank: number;

  /**
   * Array of length `globalRank` specifying global dimension names.
   */
  globalDimensionNames: readonly string[];

  /**
   * Number of displayed dimensions.  Must be <= 3.
   */
  displayRank: number;

  /**
   * Array of length 3.  The first `displayRank` elements specify the indices of the the global
   * dimensions that are displayed.  The remaining elements are `-1`.
   */
  displayDimensionIndices: Int32Array;
}

const displayInfo: DisplayDimensionRenderInfo = {
  globalRank: 3,
  displayRank: 3,
  globalDimensionNames: ['z', 'y', 'x'],
  displayDimensionIndices: new Int32Array([0, 1, 2]),
}

export class TrackableZoom extends RefCounted
{
  readonly changed = new NullarySignal();
  private value_: number = Number.NaN;

  get value() {
    return this.value_;
  }

  set value(value: number) {
    if (Object.is(value, this.value_)) {
      return;
    }
    this.value_ = value;
    this.changed.dispatch();
  }

  constructor() {
    super();
    this.value_ = 1;
  }
}

export class NavigationState extends RefCounted {
  changed = new NullarySignal();

  displayDimensionRenderInfo = displayInfo;

  constructor(
    public position: Owned<Position>,
    public zoomFactor: any,
    public orientation: any,
  ) {
    super();
    this.registerDisposer(position);
    this.registerDisposer(zoomFactor);
    this.registerDisposer(position.changed.add(this.changed.dispatch));
    this.registerDisposer(this.zoomFactor.changed.add(this.changed.dispatch));
  }

  get coordinateSpace() {
    return this.position.coordinateSpace;
  }
  get valid() {
    return this.position.valid && !Number.isNaN(this.zoomFactor.value);
  }

  zoomBy(factor: number) {
    this.zoomFactor.value *= factor;
  }

  toMat4(mat: mat4) {
    mat4.fromQuat(mat, this.orientation.orientation);
    const { value: voxelCoordinates } = this.position;
    const { displayDimensionIndices } = this.displayDimensionRenderInfo;
    for (let i = 0; i < 3; ++i) {
      const dim = displayDimensionIndices[i];
      const scale =  this.zoomFactor.value;
      mat[i] *= scale;
      mat[4 + i] *= scale;
      mat[8 + i] *= scale;
      mat[12 + i] = voxelCoordinates[dim] || 0;
    }
  }

  updateDisplayPosition(
    fun: (pos: vec3) => boolean | void,
    temp: vec3 = tempVec3,
  ): boolean {
    const {
      coordinateSpace: { value: coordinateSpace },
      value: voxelCoordinates,
    } = this.position;
    const displayRank = 3;
    const displayDimensionIndices = new Int32Array([0, 1, 2]);
    if (coordinateSpace === undefined) return false;
    temp.fill(0);
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      temp[i] = voxelCoordinates[dim];
    }
    if (fun(temp) !== false) {
      for (let i = 0; i < displayRank; ++i) {
        const dim = displayDimensionIndices[i];
        voxelCoordinates[dim] = temp[i];
      }
      this.position.changed.dispatch();
      return true;
    }
    return false;
  }

  translateVoxelsRelative(translation: vec3) {
    if (!this.valid) {
      return;
    }
    const temp = vec3.transformQuat(
      tempVec3,
      translation,
      this.orientation.orientation,
    );
    const { position } = this;
    const { value: voxelCoordinates } = position;
    const displayRank = 3;
    const displayDimensionIndices = new Int32Array([0, 1, 2]);
    const { bounds } = position.coordinateSpace.value;
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const adjustment = temp[i];
      if (adjustment === 0) continue;
      voxelCoordinates[dim] = clampAndRoundCoordinateToVoxelCenter(
        bounds,
        dim,
        voxelCoordinates[dim] + adjustment,
      );
    }
    this.position.changed.dispatch();
  }
}
