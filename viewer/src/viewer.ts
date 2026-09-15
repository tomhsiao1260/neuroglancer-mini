/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The viewer: one zarr volume shown in any number of cross-section views.
 *
 *   const viewer = new Viewer({ container, store, onMissingChunk });
 *   const view = viewer.addView(element, "xy");
 *   await viewer.loaded;
 *   viewer.setPosition({ x: 100, y: 200, z: 300 });
 *   viewer.onViewChanged(() => console.log(viewer.position, viewer.zoom));
 *   viewer.onPointerMove((point) => console.log(point));
 *   view.dispose();
 *
 * The viewer draws on a canvas that fills `container`.  Each view draws into the part of the canvas
 * under its element, so views can be laid out with any CSS, as long as their elements lie inside
 * `container`.  All views share one position and zoom.
 *
 * Points are in voxels of the full-resolution scale, with `x`, `y` and `z` along the last, middle and
 * first dimensions of the zarr array.  Voxel `(i, j, k)` is centered on `{ x: i, y: j, z: k }` and
 * extends half a voxel around it, so rounding a point gives the voxel that contains it.
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
  makeCoordinateSpace,
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
import { Signal } from "#src/util/signal.js";
import { RPC } from "#src/worker/worker_rpc.js";

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface MissingChunk {
  // Path of the chunk's file within the store, e.g. `0/52/24/18`.
  key: string;
}

/**
 * Called for each chunk whose file is not in the store, at most once per chunk while the viewer is
 * open.  Return (or resolve to) `true` once the file has been added to the store, to load the chunk
 * again; otherwise the chunk is shown as empty.
 */
export type MissingChunkHandler = (
  chunk: MissingChunk,
) => boolean | void | Promise<boolean | void>;

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

// Converts the viewer's (z, y, x) coordinates to a point.
function toPoint(coordinates: ArrayLike<number>): Point {
  return { x: coordinates[2], y: coordinates[1], z: coordinates[0] };
}

export interface ViewerOptions {
  // Element the viewer draws in.  View elements must lie inside it.
  container: HTMLElement;
  // Where the volume is read from.
  store: ZarrStoreSpec;
  // What to do about chunks missing from the store; by default they are shown as empty.
  onMissingChunk?: MissingChunkHandler;
}

export class Viewer extends RefCounted {
  display: DisplayContext;
  chunkManager: ChunkManager;
  // The render layer that draws the volume; `undefined` until the volume has loaded.
  renderLayer = new WatchableValue<ImageRenderLayer | undefined>(undefined);
  // Resolves once the volume has loaded; rejects if it could not be loaded.
  loaded: Promise<void>;

  // Decides which chunks to load, and reads and decodes them.
  private worker: Worker;
  private coordinateSpace = new TrackableCoordinateSpace();
  // Position, in the viewer's (z, y, x) coordinates, and zoom shared by all views.
  private sharedPosition = this.registerDisposer(
    new Position(this.coordinateSpace),
  );
  private sharedZoom = this.registerDisposer(new TrackableZoom());
  // Preferred size of a voxel of the chosen scale, in screen pixels (1: pick the scale whose voxels
  // are closest to one pixel).  It is shared with the worker by the render layer.
  private renderScaleTarget = new WatchableValue(1);
  // The pointer's last position over a view, if it is over one.
  private pointer:
    | { view: SliceViewPanel; clientX: number; clientY: number }
    | undefined;
  private pointerMoved = new Signal<(point: Point | undefined) => void>();

  constructor({ container, store, onMissingChunk }: ViewerOptions) {
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

    // When the view moves under a still pointer, the point under the pointer changes.
    this.registerDisposer(
      this.onViewChanged(() => {
        if (this.pointer !== undefined) this.reportPointer();
      }),
    );

    this.loaded = this.loadVolume(store, onMissingChunk);
  }

  // Center of the views, or `undefined` until the volume has loaded.
  get position(): Point | undefined {
    if (!this.sharedPosition.valid) return undefined;
    return toPoint(this.sharedPosition.value);
  }

  // Centers the views on `point`.  Before the volume has loaded, the position is replaced by the
  // center of the volume once it loads.
  setPosition({ x, y, z }: Point) {
    this.sharedPosition.value.set([z, y, x]);
    this.sharedPosition.changed.dispatch();
  }

  // Size of a screen pixel, in voxels; larger values show more of the volume.
  get zoom() {
    return this.sharedZoom.value;
  }

  setZoom(zoom: number) {
    this.sharedZoom.value = zoom;
  }

  // Calls `callback` whenever the position or zoom changes.  Returns a function that stops the calls.
  onViewChanged(callback: () => void) {
    const removePositionListener = this.sharedPosition.changed.add(callback);
    const removeZoomListener = this.sharedZoom.changed.add(callback);
    return () => {
      removePositionListener();
      removeZoomListener();
    };
  }

  // Calls `callback` with the point under the pointer whenever it changes: when the pointer moves
  // over a view, or the view moves under it.  The point is `undefined` when the pointer leaves the
  // views.  Returns a function that stops the calls.
  onPointerMove(callback: (point: Point | undefined) => void) {
    return this.pointerMoved.add(callback);
  }

  /**
   * Shows the volume in `element`, on the plane named by `orientation`.  The view is drawn where the
   * element is on the page, which must be inside the container.  Call `dispose()` on the returned
   * view to remove it; the element itself is left in place.
   */
  addView(element: HTMLElement, orientation: ViewOrientation) {
    const navigationState = new NavigationState(
      this.sharedPosition.addRef(),
      this.sharedZoom.addRef(),
      viewRotations[orientation](),
    );
    const view = new SliceViewPanel(element, navigationState, this);

    const onPointerMove = (event: PointerEvent) => {
      this.pointer = { view, clientX: event.clientX, clientY: event.clientY };
      this.reportPointer();
    };
    const onPointerLeave = () => {
      if (this.pointer?.view !== view) return;
      this.pointer = undefined;
      this.pointerMoved.dispatch(undefined);
    };
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerleave", onPointerLeave);
    view.registerDisposer(() => {
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      onPointerLeave();
    });
    return view;
  }

  private reportPointer() {
    const { view, clientX, clientY } = this.pointer!;
    const coordinates = view.pointAt(clientX, clientY);
    this.pointerMoved.dispatch(
      coordinates === undefined ? undefined : toPoint(coordinates),
    );
  }

  // Loads the zarr volume, sets the coordinate spaces from the volume bounds and creates the render
  // layer that draws the volume.
  private async loadVolume(
    store: ZarrStoreSpec,
    onMissingChunk: MissingChunkHandler | undefined,
  ) {
    const volume = await loadZarrVolume(this.chunkManager, store);
    if (this.wasDisposed) return;

    if (onMissingChunk !== undefined) {
      // Keys already passed to `onMissingChunk`.  A chunk reloaded after the handler returned `true`
      // but still missing is not passed again, so a handler cannot cause endless reloads.
      const reportedKeys = new Set<string>();
      volume.missingChunk.add((key, reload) => {
        if (reportedKeys.has(key)) return;
        reportedKeys.add(key);
        Promise.resolve(onMissingChunk({ key })).then(
          (added) => {
            if (added === true) reload();
          },
          (error) => {
            console.error(`Missing chunk handler failed for ${key}:`, error);
          },
        );
      });
    }

    this.coordinateSpace.value = makeCoordinateSpace(
      volume.lowerBounds,
      volume.upperBounds,
    );

    this.renderLayer.value = new ImageRenderLayer(volume, {
      renderScaleTarget: this.renderScaleTarget,
    });
  }
}
