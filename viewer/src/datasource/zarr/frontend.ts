/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { WithParameters } from "#src/chunk_manager/frontend.js";
import {
  MISSING_CHUNK_RPC_ID,
  VolumeChunkSourceParameters,
} from "#src/datasource/zarr/base.js";
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
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { verifyObject } from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";
import { Signal } from "#src/util/signal.js";
import { registerRPC } from "#src/worker/worker_rpc.js";

// Called with the store key of a chunk whose file is missing, and a function that loads the chunk
// again.
type MissingChunkListener = (key: string, reload: () => void) => void;

class ZarrVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {
  missingChunk = new Signal<MissingChunkListener>();
}

registerRPC(MISSING_CHUNK_RPC_ID, function (x) {
  const source = this.get(x.source) as ZarrVolumeChunkSource | undefined;
  if (source === undefined) return;
  source.missingChunk.dispatch(x.key, () => source.reloadChunk(x.chunk));
});

interface ZarrScaleInfo {
  // Path of the scale's array within the store.
  path: string;
  transform: Float64Array;
  metadata: ArrayMetadata;
}

interface ZarrMultiscaleInfo {
  store: ZarrStoreSpec;
  rank: number;
  // Bounds of the volume in voxels of the full-resolution scale, in zarr (z, y, x) order.
  lowerBounds: Float64Array;
  upperBounds: Float64Array;
  dataType: DataType;
  scales: ZarrScaleInfo[];
}

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  // Reports the missing chunks of every scale.
  missingChunk = new Signal<MissingChunkListener>();

  get dataType() {
    return this.multiscale.dataType;
  }

  get lowerBounds() {
    return this.multiscale.lowerBounds;
  }

  get upperBounds() {
    return this.multiscale.upperBounds;
  }

  get rank() {
    return this.multiscale.rank;
  }

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    public multiscale: ZarrMultiscaleInfo,
  ) {
    super(chunkManager);
  }

  // Returns the chunk source of each scale, finest first, with the transform from its chunk grid to
  // the viewer's coordinates.  The chunk sources run their `download` in the worker (see
  // `datasource/zarr/backend.ts`).
  getSources() {
    return this.multiscale.scales.map(
      (scale): SliceViewSingleResolutionSource<VolumeChunkSource> => {
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
        const [spec] = makeDefaultVolumeChunkSpecifications({
          rank,
          dataType: metadata.dataType,
          upperVoxelBound: permutedDataShape,
          chunkDataSizes: [permutedChunkShape],
        });
        // Every call (one per view) returns the same chunk source for a scale.  A viewer's chunk
        // manager holds a single volume, so the scale's path identifies the source.
        const options = {
          spec,
          parameters: { store: this.multiscale.store, path: scale.path, metadata },
        };
        const chunkSource = this.chunkManager.getChunkSource(
          `zarr:${scale.path}`,
          () => new ZarrVolumeChunkSource(this.chunkManager, options),
        );
        // Adding a listener that is already added has no effect.
        chunkSource.missingChunk.add(this.missingChunk.dispatch);
        return { chunkSource, chunkToMultiscaleTransform: transform };
      },
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
  const { rank } = multiscale;
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

  // The volume starts at the translation of the full-resolution scale (-0.5 for OME's voxel-center
  // convention) and spans its shape.
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const baseScale = multiscale.scales[0];
  const baseZarrMetadata = scaleZarrMetadata[0];
  for (let i = 0; i < rank; ++i) {
    const lower = (lowerBounds[i] = baseScale.transform[(rank + 1) * rank + i]);
    upperBounds[i] = lower + baseZarrMetadata.shape[i];
  }

  return {
    store: storeSpec,
    rank,
    lowerBounds,
    upperBounds,
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
