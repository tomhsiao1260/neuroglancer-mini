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

import type {
  SliceViewChunkSource,
  SliceViewChunkSpecification,
} from "#src/sliceview/base.js";
import { makeSliceViewChunkSpecification } from "#src/sliceview/base.js";
import { DATA_TYPE_BYTES, DataType } from "#src/util/data_type.js";

export { DATA_TYPE_BYTES, DataType };

export interface VolumeChunkSpecification
  extends SliceViewChunkSpecification<Uint32Array> {
  dataType: DataType;
}

/**
 * Returns a chunk specification for each chunk size in `chunkDataSizes`.
 */
export function makeDefaultVolumeChunkSpecifications(options: {
  rank: number;
  dataType: DataType;
  upperVoxelBound: Float32Array;
  chunkDataSizes: Uint32Array[];
}): VolumeChunkSpecification[] {
  const { dataType } = options;
  return options.chunkDataSizes.map((chunkDataSize) => ({
    ...makeSliceViewChunkSpecification({ ...options, chunkDataSize }),
    dataType,
  }));
}

export interface VolumeChunkSource extends SliceViewChunkSource {
  spec: VolumeChunkSpecification;
}
