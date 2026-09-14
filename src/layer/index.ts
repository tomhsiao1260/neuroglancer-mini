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

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { loadZarrVolume } from "#src/datasource/zarr/frontend.js";
import { getRenderLayerTransform } from "#src/render/render_coordinate_transform.js";
import type { RenderLayer } from "#src/render/renderlayer.js";
import { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import {
  makeCombinedCoordinateSpace,
  TrackableCoordinateSpace,
} from "#src/state/coordinate_transform.js";
import { Position } from "#src/state/navigation_state.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import * as matrix from "#src/util/matrix.js";
import { NullarySignal } from "#src/util/signal.js";

// Chunks and metadata are read from the folder the user picked.  Only the path after the first
// component (here `scroll.zarr`) is used to look files up in `self.fileTree`; see
// `util/http_request.ts`.
const DATA_URL = "http://localhost:9000/scroll.zarr";

/**
 * The one image layer of the viewer.  It loads the zarr volume, sets the coordinate spaces from the
 * volume bounds and adds the render layer that draws the volume.
 */
export class ImageUserLayer extends RefCounted {
  localCoordinateSpace = new TrackableCoordinateSpace();
  localPosition = this.registerDisposer(
    new Position(this.localCoordinateSpace),
  );
  sliceViewRenderScaleTarget = new WatchableValue(1);

  layersChanged = new NullarySignal();
  renderLayers = new Array<RenderLayer>();

  constructor(
    public manager: {
      chunkManager: ChunkManager;
      coordinateSpace: TrackableCoordinateSpace;
    },
  ) {
    super();
    this.load().catch((error) => {
      console.error("Failed to load data source:", error);
    });
  }

  *readyRenderLayers() {
    yield* this.renderLayers;
  }

  private async load() {
    const { chunkManager, coordinateSpace } = this.manager;
    const volume = await loadZarrVolume(chunkManager, DATA_URL);
    if (this.wasDisposed) return;

    // The global (navigation) and local coordinate spaces both span the volume.
    const { modelSpace } = volume;
    coordinateSpace.value = makeCombinedCoordinateSpace(modelSpace);
    this.localCoordinateSpace.value = makeCombinedCoordinateSpace(modelSpace);

    this.addRenderLayer(
      new ImageRenderLayer(volume, {
        transform: new WatchableValue(
          getRenderLayerTransform(matrix.createIdentity(Float32Array, 4)),
        ),
        renderScaleTarget: this.sliceViewRenderScaleTarget,
        localPosition: this.localPosition,
      }),
    );
  }

  addRenderLayer(layer: Owned<RenderLayer>) {
    this.renderLayers.push(layer);
    const { layersChanged } = this;
    layer.layerChanged.add(layersChanged.dispatch);
    layersChanged.dispatch();
  }
}
