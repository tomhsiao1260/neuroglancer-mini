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
import "#src/datasource/zarr/codec/blosc/resolve.js";
import "#src/datasource/zarr/codec/bytes/resolve.js";
import "#src/datasource/zarr/codec/gzip/resolve.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata/index.js";
import { parseV2Metadata } from "#src/datasource/zarr/metadata/parse.js";
import type { OmeMultiscaleMetadata } from "#src/datasource/zarr/ome.js";
import { parseOmeMetadata } from "#src/datasource/zarr/ome.js";
import type { SliceViewSingleResolutionSource } from "#src/sliceview/frontend.js";
import type { VolumeSourceOptions } from "#src/sliceview/volume/base.js";
import {
  DataType,
  makeDefaultVolumeChunkSpecifications,
  VolumeType,
} from "#src/sliceview/volume/base.js";
import {
  MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/sliceview/volume/frontend.js";
import { transposeNestedArrays } from "#src/util/array.js";
import type { Borrowed } from "#src/util/disposable.js";
import {
  cancellableFetchOk,
  isNotFoundError,
  responseJson,
} from "#src/util/http_request.js";
import { verifyObject } from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";

class ZarrVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {}

interface ZarrScaleInfo {
  url: string;
  transform: Float64Array;
  metadata: ArrayMetadata;
}

interface ZarrMultiscaleInfo {
  coordinateSpace: CoordinateSpace;
  dataType: DataType;
  scales: ZarrScaleInfo[];
}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  volumeType = VolumeType.IMAGE;

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
  getSources(volumeSourceOptions: VolumeSourceOptions) {
    return transposeNestedArrays(
      this.multiscale.scales.map((scale) => {
        const { metadata } = scale;
        const { rank, codecs, shape } = metadata;
        const readChunkShape = codecs.layoutInfo[0].readChunkShape;
        const { physicalToLogicalDimension } = metadata.codecs.layoutInfo[0];
        const permutedChunkShape = new Uint32Array(rank);
        const permutedDataShape = new Float32Array(rank);
        const orderTransform = new Float32Array((rank + 1) ** 2);
        orderTransform[(rank + 1) ** 2 - 1] = 1;
        for (let i = 0; i < rank; ++i) {
          const decodedDim = physicalToLogicalDimension[rank - 1 - i];
          permutedChunkShape[i] = readChunkShape[decodedDim];
          permutedDataShape[i] = shape[decodedDim];
          orderTransform[i + decodedDim * (rank + 1)] = 1;
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
          chunkToMultiscaleTransform: transform,
          dataType: metadata.dataType,
          upperVoxelBound: permutedDataShape,
          volumeType: this.volumeType,
          chunkDataSizes: [permutedChunkShape],
          volumeSourceOptions,
          fillValue: metadata.fillValue,
        }).map(
          (spec): SliceViewSingleResolutionSource<VolumeChunkSource> => ({
            chunkSource: this.chunkManager.getChunkSource(
              ZarrVolumeChunkSource,
              {
                spec,
                parameters: {
                  url: scale.url,
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

async function getJsonResource(url: string): Promise<any | undefined> {
  try {
    return await cancellableFetchOk(url, responseJson);
  } catch (e) {
    if (isNotFoundError(e)) return undefined;
    throw e;
  }
}

async function resolveOmeMultiscale(
  multiscale: OmeMultiscaleMetadata,
): Promise<ZarrMultiscaleInfo> {
  const scaleZarrMetadata: ArrayMetadata[] = await Promise.all(
    multiscale.scales.map(async (scale) =>
      parseV2Metadata(await getJsonResource(`${scale.url}/.zarray`)),
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
          scale.url,
        )} to have rank ${rank}, ` + `but received: ${zarrMetadata.rank}`,
      );
    }
    if (zarrMetadata.dataType !== dataType) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.url,
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
    coordinateSpace: resolvedCoordinateSpace,
    dataType,
    scales: multiscale.scales.map((scale, i) => ({
      url: scale.url,
      transform: scale.transform,
      metadata: scaleZarrMetadata[i],
    })),
  };
}

/**
 * Loads an OME-Zarr (zarr v2) multiscale volume: reads `.zattrs` for the list of scales, then the
 * `.zarray` of every scale.
 */
export async function loadZarrVolume(
  chunkManager: ChunkManager,
  url: string,
): Promise<MultiscaleVolumeChunkSource> {
  const zattrs = verifyObject(await getJsonResource(`${url}/.zattrs`));
  const multiscale = parseOmeMetadata(url, zattrs);
  if (multiscale === undefined) {
    throw new Error("No OME multiscale metadata found");
  }
  return new MultiscaleVolumeChunkSource(
    chunkManager,
    await resolveOmeMultiscale(multiscale),
  );
}
