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

import { WithParameters } from "#src/chunk_manager/backend.js";
import {
  MISSING_CHUNK_RPC_ID,
  VolumeChunkSourceParameters,
} from "#src/datasource/zarr/base.js";
import { decodeChunk } from "#src/datasource/zarr/decode.js";
import { createZarrStore } from "#src/datasource/zarr/store.js";
import type { VolumeChunk } from "#src/render/backend.js";
import { VolumeChunkSource } from "#src/render/backend.js";
import { registerSharedObject } from "#src/worker/worker_rpc.js";

/**
 * Worker side of one scale of a zarr volume.  The chunk manager calls `download` for each chunk it
 * decides to load: the chunk file is read from the store and decoded into `chunk.data`.  A chunk
 * missing from the store keeps `data === null` and is drawn with the fill value; the main thread is
 * told about it, and may add the file and ask for the chunk again.
 */
@registerSharedObject()
export class ZarrVolumeChunkSource extends WithParameters(
  VolumeChunkSource,
  VolumeChunkSourceParameters,
) {
  private store = createZarrStore(this.parameters.store);

  async download(chunk: VolumeChunk) {
    chunk.chunkDataSize = this.spec.chunkDataSize;
    const { metadata, path } = this.parameters;
    // The chunk grid position is in (x, y, z) order, while zarr chunk keys list the chunk indices in
    // (z, y, x) order, e.g. `52/24/18`.
    const key = `${path}/${Array.from(chunk.chunkGridPosition)
      .reverse()
      .join(metadata.dimensionSeparator)}`;
    let data: Uint8Array | undefined;
    try {
      data = await this.store.get(key);
    } catch (e) {
      // Drawn like a missing chunk; the failure is only reported.
      console.error(`Failed to read chunk: ${key}`, e);
      return;
    }
    if (data === undefined) {
      this.rpc!.invoke(MISSING_CHUNK_RPC_ID, {
        source: this.rpcId,
        chunk: chunk.key,
        key,
      });
      return;
    }
    chunk.data = await decodeChunk(metadata, data);
  }
}
