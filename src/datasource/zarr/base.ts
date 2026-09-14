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

import type { ArrayMetadata } from "#src/datasource/zarr/metadata.js";
import type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";

export class VolumeChunkSourceParameters {
  // The store holding the volume.
  store: ZarrStoreSpec;
  // Path of this scale's array within the store, e.g. `0`.
  path: string;
  metadata: ArrayMetadata;
  static RPC_ID = "zarr/VolumeChunkSource";
}
