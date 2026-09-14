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

/**
 * @file The viewer: one zarr volume shown in any number of cross-section views.
 *
 *   const viewer = new Viewer({ container, store });
 *   viewer.addView(element, "xy");
 *
 * The viewer draws on a canvas that fills `container`.  Each view draws into the part of the canvas
 * under its element, so views can be laid out with any CSS, as long as their elements lie inside
 * `container`.  All views share one position and zoom.
 */

import {
  CapacitySpecification,
  ChunkManager,
  ChunkQueueManager,
} from "#src/chunk_manager/frontend.js";
import { loadZarrVolume } from "#src/datasource/zarr/frontend.js";
import type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
import { DisplayContext, SliceViewPanel } from "#src/render/panel.js";
import { ImageRenderLayer } from "#src/render/renderlayer.js";
import {
  makeCombinedCoordinateSpace,
  TrackableCoordinateSpace,
} from "#src/state/coordinate_transform.js";
import {
  NavigationState,
  Position,
  TrackableZoom,
} from "#src/state/navigation_state.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { quat } from "#src/util/geom.js";
import { RPC } from "#src/worker/worker_rpc.js";

/**
 * The plane a view shows, named by the two volume axes on screen.
 */
export type ViewOrientation = "xy" | "xz" | "yz";

// Rotation of the view for each orientation.  The viewer's coordinates are (z, y, x).
const viewRotations: Record<ViewOrientation, () => quat> = {
  // x increases to the left and y downward; the view looks along z.
  xy: () => quat.rotateY(quat.create(), quat.create(), Math.PI / 2),
  // z increases to the right and x downward; the view looks along y.
  xz: () => quat.rotateX(quat.create(), quat.create(), Math.PI / 2),
  // z increases to the right and y downward; the view looks along x.
  yz: () => quat.create(),
};

export interface ViewerOptions {
  // Element the viewer draws in.  View elements must lie inside it.
  container: HTMLElement;
  // Where the volume is read from.
  store: ZarrStoreSpec;
}

export class Viewer extends RefCounted {
  display: DisplayContext;
  // Decides which chunks to load, and reads and decodes them.
  worker: Worker;
  chunkManager: ChunkManager;

  // Coordinate space of the volume, set once the volume has loaded.
  coordinateSpace = new TrackableCoordinateSpace();
  // Position and zoom shared by all views.
  position = this.registerDisposer(new Position(this.coordinateSpace));
  zoom = this.registerDisposer(new TrackableZoom());

  // The render layer that draws the volume; `undefined` until the volume has loaded.
  renderLayer = new WatchableValue<ImageRenderLayer | undefined>(undefined);

  // Resolves once the volume has loaded; rejects if it could not be loaded.
  loaded: Promise<void>;

  // Position in the image's local coordinate space, which spans the volume like the global
  // coordinate space.  It is shared with the worker by the render layer.
  private localCoordinateSpace = new TrackableCoordinateSpace();
  private localPosition = this.registerDisposer(
    new Position(this.localCoordinateSpace),
  );
  private renderScaleTarget = new WatchableValue(1);

  constructor({ container, store }: ViewerOptions) {
    super();
    this.display = this.registerDisposer(new DisplayContext(container));

    this.worker = new Worker(
      new URL("./worker/chunk_worker.bundle.js", import.meta.url),
      { type: "module" },
    );
    const rpc = new RPC(this.worker, true);
    const chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(rpc, this.display.gl, {
        gpuMemory: new CapacitySpecification({
          defaultItemLimit: 1e6,
          defaultSizeLimit: 1e9,
        }),
        systemMemory: new CapacitySpecification({
          defaultItemLimit: 1e7,
          defaultSizeLimit: 2e9,
        }),
        download: new CapacitySpecification({
          defaultItemLimit: 100,
          defaultSizeLimit: Number.POSITIVE_INFINITY,
        }),
      }),
    );
    chunkQueueManager.registerDisposer(() => this.worker.terminate());
    this.chunkManager = this.registerDisposer(
      new ChunkManager(chunkQueueManager),
    );

    this.loaded = this.loadVolume(store);
  }

  /**
   * Shows the volume in `element`, on the plane named by `orientation`.  The view is drawn where the
   * element is on the page, which must be inside the container.
   */
  addView(element: HTMLElement, orientation: ViewOrientation) {
    const navigationState = new NavigationState(
      this.position.addRef(),
      this.zoom.addRef(),
      { orientation: viewRotations[orientation]() },
    );
    return new SliceViewPanel(element, navigationState, this);
  }

  // Loads the zarr volume, sets the coordinate spaces from the volume bounds and creates the render
  // layer that draws the volume.
  private async loadVolume(store: ZarrStoreSpec) {
    const volume = await loadZarrVolume(this.chunkManager, store);
    if (this.wasDisposed) return;

    const { modelSpace } = volume;
    this.coordinateSpace.value = makeCombinedCoordinateSpace(modelSpace);
    this.localCoordinateSpace.value = makeCombinedCoordinateSpace(modelSpace);

    this.renderLayer.value = new ImageRenderLayer(volume, {
      renderScaleTarget: this.renderScaleTarget,
      localPosition: this.localPosition,
    });
  }
}
