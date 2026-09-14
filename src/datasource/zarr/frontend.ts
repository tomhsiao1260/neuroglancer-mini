/**
 * @license
 * Copyright 2020 Google Inc.
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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpace } from "#src/state/coordinate_transform.js";
import {
  makeCoordinateSpace,
  makeIdentityTransformedBoundingBox,
} from "#src/state/coordinate_transform.js";
import { VolumeChunkSourceParameters } from "#src/datasource/zarr/base.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata.js";
import { parseV2Metadata } from "#src/datasource/zarr/metadata.js";
import type { OmeMultiscaleMetadata } from "#src/datasource/zarr/ome.js";
import { parseOmeMetadata } from "#src/datasource/zarr/ome.js";
import type { ZarrStore, ZarrStoreSpec } from "#src/datasource/zarr/store.js";
import { createZarrStore } from "#src/datasource/zarr/store.js";
import { makeDefaultVolumeChunkSpecifications } from "#src/render/base.js";
import type { SliceViewSingleResolutionSource } from "#src/render/frontend.js";
import {
  MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/render/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { verifyObject } from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";

class ZarrVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {}

interface ZarrScaleInfo {
  // Path of the scale's array within the store.
  path: string;
  transform: Float64Array;
  metadata: ArrayMetadata;
}

interface ZarrMultiscaleInfo {
  store: ZarrStoreSpec;
  coordinateSpace: CoordinateSpace;
  dataType: DataType;
  scales: ZarrScaleInfo[];
}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  get dataType() {
    return this.multiscale.dataType;
  }

  get modelSpace() {
    return this.multiscale.coordinateSpace;
  }

  get rank() {
    return this.multiscale.coordinateSpace.rank;
  }

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    public multiscale: ZarrMultiscaleInfo,
  ) {
    super(chunkManager);
  }

  // Returns, for each scale, the chunk sources that load it (one per chunk size).  The chunk
  // sources run their `download` in the worker (see `datasource/zarr/backend.ts`).
  getSources() {
    return transposeNestedArrays(
      this.multiscale.scales.map((scale) => {
        const { metadata } = scale;
        const { rank, chunkShape, shape } = metadata;
        // Zarr lists dimensions in (z, y, x) order; chunk space uses the reverse order, (x, y, z),
        // which matches C-order voxel data where x varies fastest.
        const permutedChunkShape = new Uint32Array(rank);
        const permutedDataShape = new Float32Array(rank);
        const orderTransform = new Float32Array((rank + 1) ** 2);
        orderTransform[(rank + 1) ** 2 - 1] = 1;
        for (let i = 0; i < rank; ++i) {
          const zarrDim = rank - 1 - i;
          permutedChunkShape[i] = chunkShape[zarrDim];
          permutedDataShape[i] = shape[zarrDim];
          orderTransform[i + zarrDim * (rank + 1)] = 1;
        }
        const transform = new Float32Array((rank + 1) ** 2);
        matrix.multiply<Float32Array | Float64Array>(
          transform,
          rank + 1,
          scale.transform,
          rank + 1,
          orderTransform,
          rank + 1,
          rank + 1,
          rank + 1,
          rank + 1,
        );
        return makeDefaultVolumeChunkSpecifications({
          rank,
          dataType: metadata.dataType,
          upperVoxelBound: permutedDataShape,
          chunkDataSizes: [permutedChunkShape],
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(
              ZarrVolumeChunkSource,
              {
                spec,
                parameters: {
                  store: this.multiscale.store,
                  path: scale.path,
                  metadata,
                },
              },
            ),
            chunkToMultiscaleTransform: transform,
          }),
        );
      }),
    );
  }
}

// Reads and parses the JSON file at `key`, or returns `undefined` if the store has no such file.
async function readJson(store: ZarrStore, key: string): Promise<any> {
  const data = await store.get(key);
  if (data === undefined) return undefined;
  return JSON.parse(new TextDecoder().decode(data));
}

async function resolveOmeMultiscale(
  storeSpec: ZarrStoreSpec,
  store: ZarrStore,
  multiscale: OmeMultiscaleMetadata,
): Promise<ZarrMultiscaleInfo> {
  const scaleZarrMetadata: ArrayMetadata[] = await Promise.all(
    multiscale.scales.map(async (scale) =>
      parseV2Metadata(await readJson(store, `${scale.path}/.zarray`)),
    ),
  );
  const dataType = scaleZarrMetadata[0].dataType;
  const numScales = scaleZarrMetadata.length;
  const rank = multiscale.coordinateSpace.rank;
  for (let i = 0; i < numScales; ++i) {
    const scale = multiscale.scales[i];
    const zarrMetadata = scaleZarrMetadata[i];
    if (zarrMetadata.rank !== rank) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.path,
        )} to have rank ${rank}, ` + `but received: ${zarrMetadata.rank}`,
      );
    }
    if (zarrMetadata.dataType !== dataType) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.path,
        )} to have data type ` +
          `${DataType[dataType]}, but received: ${
            DataType[zarrMetadata.dataType]
          }`,
      );
    }
  }

  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const baseScale = multiscale.scales[0];
  const baseZarrMetadata = scaleZarrMetadata[0];
  for (let i = 0; i < rank; ++i) {
    const lower = (lowerBounds[i] = baseScale.transform[(rank + 1) * rank + i]);
    upperBounds[i] = lower + baseZarrMetadata.shape[i];
  }
  const boundingBox = makeIdentityTransformedBoundingBox({
    lowerBounds,
    upperBounds,
  });

  const { coordinateSpace } = multiscale;
  const resolvedCoordinateSpace = makeCoordinateSpace({
    names: coordinateSpace.names,
    units: coordinateSpace.units,
    scales: coordinateSpace.scales,
    boundingBoxes: [boundingBox],
  });

  return {
    store: storeSpec,
    coordinateSpace: resolvedCoordinateSpace,
    dataType,
    scales: multiscale.scales.map((scale, i) => ({
      path: scale.path,
      transform: scale.transform,
      metadata: scaleZarrMetadata[i],
    })),
  };
}

/**
 * Loads an OME-Zarr (zarr v2) multiscale volume from `storeSpec`: reads `.zattrs` for the list of
 * scales, then the `.zarray` of every scale.
 */
export async function loadZarrVolume(
  chunkManager: ChunkManager,
  storeSpec: ZarrStoreSpec,
): Promise<MultiscaleVolumeChunkSource> {
  const store = createZarrStore(storeSpec);
  const zattrs = verifyObject(await readJson(store, ".zattrs"));
  const multiscale = parseOmeMetadata(zattrs);
  if (multiscale === undefined) {
    throw new Error("No OME multiscale metadata found");
  }
  return new MultiscaleVolumeChunkSource(
    chunkManager,
    await resolveOmeMultiscale(storeSpec, store, multiscale),
  );
}
