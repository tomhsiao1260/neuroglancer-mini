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

import "#src/style.css";
import { RefCounted } from "#src/util/disposable.js";
import {
  CapacitySpecification,
  ChunkManager,
  ChunkQueueManager,
} from "#src/chunk_manager/frontend.js";
import { loadZarrVolume } from "#src/datasource/zarr/frontend.js";
import {
  makeCombinedCoordinateSpace,
  TrackableCoordinateSpace,
} from "#src/state/coordinate_transform.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { ImageRenderLayer } from "#src/render/renderlayer.js";
import type { GL } from "#src/webgl/context.js";
import { RPC, READY_ID } from "#src/worker/worker_rpc.js";
import {
  NavigationState,
  Position,
  TrackableZoom,
} from "#src/state/navigation_state.js";
import { DisplayContext, SliceViewPanel } from "#src/render/panel.js";
import { quat } from "#src/util/geom.js";
import { handleFileBtnOnClick } from "#src/util/file_system.js";

// Chunks and metadata are read from the folder the user picked.  Only the path after the first
// component (here `scroll.zarr`) is used to look files up in `self.fileTree`; see
// `util/http_request.ts`.
const DATA_URL = "http://localhost:9000/scroll.zarr";

// root container element
const root = document.querySelector<HTMLDivElement>('#app');


/**
 * Creates and sets up the upload button for .zarr files
 */
makeUploadButton();

function makeUploadButton() {
  const button = document.createElement("button");
  button.id = "upload";
  button.innerText = "choose .zarr folder";
  button.onclick = makeMinimalViewer;

  const loading = document.createElement("div");
  loading.id = "loading";
  loading.innerText = "Loading ...";
  loading.style.display = "none";

  root?.appendChild(button);
  root?.appendChild(loading);
}

/**
 * Creates a minimal viewer for 3D volume data visualization
 */
async function makeMinimalViewer() {
  // Load data using file system API
  const fileTree = await handleFileBtnOnClick();
  self.fileTree = fileTree;

  const target = document.createElement("div");
  target.id = "neuroglancer-container";
  root?.appendChild(target);
  const display = new DisplayContext(target);
  const viewer = new Viewer(display);

  // Handle loading state
  loading(viewer.dataContext.worker);
}

/**
 * Manages the loading state UI
 * @param worker - The worker handling data processing
 */
function loading(worker: Worker) {
  const loading = document.querySelector<HTMLDivElement>("#loading");
  const button = document.querySelector<HTMLButtonElement>("#upload");
  if (loading && button) {
    loading.style.display = "inline";
    button.style.display = "none";

    worker.addEventListener("message", (e: MessageEvent<{ functionName: string }>) => {
      const isReady = e.data.functionName === READY_ID;
      if (isReady && loading) {
        loading.style.display = "none";
      }
    });
  }
}

/**
 * Interface defining the UI state of the viewer
 */
export interface ViewerUIState {
  display: DisplayContext;
  coordinateSpace: TrackableCoordinateSpace;
  chunkManager: ChunkManager;
  navigationState: NavigationState;
  // The render layer that draws the volume; `undefined` until the volume has loaded.
  renderLayer: WatchableValueInterface<ImageRenderLayer | undefined>;
}

/**
 * Manages data processing and worker communication
 */
class DataManagementContext extends RefCounted {
  worker: Worker;
  rpc: RPC;
  chunkQueueManager: ChunkQueueManager;
  chunkManager: ChunkManager;

  constructor(
    public gl: GL,
  ) {
    super();

    // Initialize Web Worker for parallel processing
    this.worker = new Worker(
      new URL("./worker/chunk_worker.bundle.js", import.meta.url),
      { type: "module" },
    );

    // Setup RPC communication with the worker
    this.rpc = new RPC(this.worker, true);

    // Handle worker ready state and file tree initialization
    this.worker.addEventListener("message", (e: MessageEvent<{ functionName: string }>) => {
      const isReady = e.data.functionName === READY_ID;
      if (isReady) {
        this.worker.postMessage({ fileTree: self.fileTree });
      }
    });

    // Initialize chunk queue manager with resource limits
    this.chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(
        this.rpc,
        this.gl,
        {
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
        },
      ),
    );

    // Ensure worker is terminated when disposed
    this.chunkQueueManager.registerDisposer(() => this.worker.terminate());

    // Initialize chunk manager for data organization
    this.chunkManager = this.registerDisposer(
      new ChunkManager(this.chunkQueueManager),
    );
  }
}

/**
 * Main viewer class: loads the volume and lays out the three panels.
 */
class Viewer extends RefCounted {
  coordinateSpace = new TrackableCoordinateSpace();
  dataContext: DataManagementContext;
  navigationState = new NavigationState(
    new Position(this.coordinateSpace),
    new TrackableZoom(),
    quat.create()
  );

  // Position in the image's local coordinate space, which spans the volume like the global
  // coordinate space.  It is shared with the worker by the render layer.
  localCoordinateSpace = new TrackableCoordinateSpace();
  localPosition = this.registerDisposer(
    new Position(this.localCoordinateSpace),
  );
  renderScaleTarget = new WatchableValue(1);

  // The render layer that draws the volume, set once the volume has loaded.
  renderLayer = new WatchableValue<ImageRenderLayer | undefined>(undefined);

  constructor(public display: DisplayContext) {
    super();

    this.dataContext = new DataManagementContext(display.gl);
    this.loadVolume().catch((error) => {
      console.error("Failed to load data source:", error);
    });

    // Create panel layout
    const panel = this.registerDisposer(
      new PanelLayout({
        renderLayer: this.renderLayer,
        coordinateSpace: this.coordinateSpace,
        chunkManager: this.dataContext.chunkManager,
        navigationState: this.navigationState,
        display: this.display,
      }),
    );

    // Setup viewer DOM
    const container = document.createElement("div");
    container.style.top = "0px";
    container.style.left = "0px";
    container.style.width = "100%";
    container.style.height = "100%";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.position = "absolute";
    container.appendChild(panel.element);
    this.display.container.appendChild(container);
  }

  // Loads the zarr volume, sets the coordinate spaces from the volume bounds and creates the render
  // layer that draws the volume.
  private async loadVolume() {
    const volume = await loadZarrVolume(this.dataContext.chunkManager, DATA_URL);
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

/**
 * Handles the layout of the viewer panels
 */
class PanelLayout extends RefCounted {
  /** Root element for the panel layout */
  element = document.createElement("div");

  constructor(public viewer: ViewerUIState) {
    super();

    // Initialize position and scale trackers
    const position = this.registerDisposer(new Position(this.viewer.coordinateSpace));
    const crossSectionScale = this.registerDisposer(new TrackableZoom());

    // Setup panel container layout
    this.element.style.flex = "1";
    this.element.style.display = "flex";
    this.element.style.flexDirection = "row";

    // Common state for all panels
    const state =  {
      display: viewer.display,
      chunkManager: viewer.chunkManager,
      renderLayer: viewer.renderLayer,
    }

    // Create XY plane panel (top view)
    const elementXY = document.createElement("div");
    elementXY.classList.add("neuroglancer-panel");
    const navigationStateXY = new NavigationState(
      position.addRef(),
      crossSectionScale.addRef(),
      { orientation: quat.create() },
    )
    new SliceViewPanel(elementXY, navigationStateXY, state);

    // Create YZ plane panel (side view)
    const elementYZ = document.createElement("div");
    elementYZ.classList.add("neuroglancer-panel");
    const navigationStateYZ = new NavigationState(
      position.addRef(),
      crossSectionScale.addRef(),
      { orientation: quat.rotateY(quat.create(), quat.create(), Math.PI / 2) },
    )
    new SliceViewPanel(elementYZ, navigationStateYZ, state);

    // Create XZ plane panel (front view)
    const elementXZ = document.createElement("div");
    elementXZ.classList.add("neuroglancer-panel");
    const navigationStateXZ = new NavigationState(
      position.addRef(),
      crossSectionScale.addRef(),
      { orientation: quat.rotateX(quat.create(), quat.create(), Math.PI / 2) },
    )
    new SliceViewPanel(elementXZ, navigationStateXZ, state);

    // Add all panels to the layout
    this.element.appendChild(elementXY);
    this.element.appendChild(elementYZ);
    this.element.appendChild(elementXZ);
  }
}

