# Neuroglancer Mini

This is a trimmed-down version of the original Neuroglancer source code, designed to make its core logic more accessible and easier to understand. This is not a new implementation, but rather a carefully curated subset of the original codebase (~115,510 lines) that has been reduced to about 8,450 lines by retaining only the minimal core functionality needed for the program to run, reducing npm dependencies, and simplifying the build process. This lightweight version serves as a learning demo, allowing developers to grasp the core concepts and architecture of Neuroglancer without being overwhelmed by the complexity of the original implementation.

<img width="1193" alt="img2" src="https://github.com/user-attachments/assets/c69a9014-3250-4d05-8350-abb96975b64c" />

Note: This is not an officially maintained version of Neuroglancer. Neuroglancer and Neuroglancer Mini are two independently developed projects, but this project is based on a reduced version of the original Neuroglancer source code.

## Motivation

When I first tried to understand Neuroglancer's source code, I found it challenging due to its complexity and numerous abstract layers. I was particularly interested in understanding:

- How data is loaded in batches
- The rendering mechanisms
- Core visualization principles

To address these challenges, I created Neuroglancer Mini by:

- Keeping only essential code for basic functionality
- Removing complex interface and data transfer logic
- Simplifying the build process
- Focusing on core visualization features

This project serves as a learning resource for developers who want to understand Neuroglancer's fundamental codebase.

## Branches

- **backward** (this README, merged into `main`): the reduced Neuroglancer code, packaged as the `viewer/` library, plus a small example page that uses it. This is where the code is reduced and explained.
- **[forward](https://github.com/tomhsiao1260/neuroglancer-mini/tree/forward)**: an app built on the same `viewer/` folder, with a Node server that downloads only the parts of a scroll you look at and keeps them locally, coordinate display, positions in the URL and a list of missing chunks. See [its README](https://github.com/tomhsiao1260/neuroglancer-mini/tree/forward#readme) for its features and setup.

## Getting Started

Please use Chrome or Edge.

<img width="1193" alt="img1" src="https://github.com/user-attachments/assets/42784acc-39cc-4585-948b-0b2d4a971ee1" />

### Option 1: Online Demo

Visit [neuroglancer-mini.vercel.app](https://neuroglancer-mini.vercel.app) and click "Open local folder" to open a local `.zarr` folder, or open a scroll straight from the Vesuvius Challenge data server:

[neuroglancer-mini.vercel.app/?zarr=https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr](https://neuroglancer-mini.vercel.app/?zarr=https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr)

The demo is built from `example/` (see `vercel.json`).

### Option 2: Local Development

Install and start the development server. `npm install` also installs the packages of `viewer/`.

```bash
git checkout backward
cd example
npm install
npm run dev
```

Then open `http://localhost:3000`.

### Supported Data

The viewer opens one OME-Zarr multiscale volume stored as Zarr v2. The example page's URL parameters choose where it comes from:

- No parameters: the start screen. Click "Open local folder" and pick the `.zarr` folder itself (the one containing `.zattrs`); this uses the File System Access API.
- `?zarr=<url>`: read the files over HTTP, where `<url>` is the URL of the `.zarr` folder. Any server that returns the files (and 404 for missing ones) works if it allows cross-origin requests (CORS): the Vesuvius Challenge data server, a static server such as `npx http-server <folder containing scroll.zarr> -p 9000 --cors`, or the server of the forward branch.

What is supported:

- Metadata: `.zattrs` with OME `multiscales`, and a `.zarray` for each scale (C order).
- Compressors: blosc and null (raw).
- Data types: uint8 (`|u1`) and uint16 (`<u2`), which is what the Vesuvius Challenge scroll and fragment volumes use, and float32 (`<f4`, shown over the range [0, 1]) for surface data such as tifxyz coordinates. Other data types are rejected with an error.
- Chunk keys may use either `.` or `/` as the dimension separator. Chunks missing from the store are shown as 0.

The volume is shown in three cross-section views (XY, YZ and XZ) that share one position and zoom. Drag with the left mouse button to pan, use the wheel to step one voxel through the slice, and hold Ctrl while using the wheel to zoom around the cursor.

## Using the Viewer

```ts
import { Viewer } from "viewer";

const viewer = new Viewer({
  container: document.querySelector<HTMLDivElement>("#container")!,
  store: { kind: "http", url: "http://localhost:9000/scroll.zarr" },
});
viewer.addView(document.querySelector<HTMLDivElement>("#left")!, "xy");
viewer.addView(document.querySelector<HTMLDivElement>("#right")!, "yz");
```

- `new Viewer({ container, store })` creates the canvas, the worker and the chunk manager and loads the volume; `viewer.loaded` resolves once it has loaded (and rejects if it could not). `store` is `{ kind: "http", url }` or `{ kind: "directory", handle }` (a `FileSystemDirectoryHandle`).
- `viewer.addView(element, "xy" | "xz" | "yz")` shows a cross-section in `element`, which can be placed anywhere inside the container with CSS, and returns the view; `view.dispose()` removes it. All views share one position and zoom.
- `viewer.position` / `viewer.setPosition({ x, y, z })` and `viewer.zoom` / `viewer.setZoom(voxelsPerPixel)` read and change the view; `viewer.onViewChanged(callback)` and `viewer.onPointerMove(callback)` report changes of the view and of the point under the pointer. Points are in full-resolution voxels, with `x`, `y`, `z` along the last, middle and first zarr dimensions; voxel `(i, j, k)` is centered on `{ x: i, y: j, z: k }`.
- `new Viewer({ ..., onMissingChunk })` is called with `{ key }` (e.g. `0/52/24/18`) for each chunk whose file is not in the store, once per chunk while the viewer is open. If it returns (or resolves to) `true`, the file is assumed to have been added and the chunk is downloaded again; otherwise the chunk is shown as empty. A downloader can be plugged in here without changing the viewer; the forward branch does this with its server.

To use the viewer in another Vite app, place `viewer/` next to the app and copy the configuration of `example/`:

- `vite.config.ts`: the `viewer` alias to `../viewer/src/index.ts`, `server.fs.allow: [".."]` (the viewer lies outside the app folder) and `worker.format: "es"`.
- `tsconfig.json`: the same `paths` entry.
- `package.json`: `"postinstall": "npm install --prefix ../viewer"`, which installs the viewer's own packages.

## Project Structure

The code is split between two threads. The **main thread** owns the WebGL canvas, the views and mouse input. A **worker** (`viewer/src/worker/chunk_worker.bundle.js`) decides which chunks are needed, reads and decodes them, and keeps them within memory limits. Most modules therefore come in pairs: `frontend.ts` runs on the main thread, `backend.ts` runs in the worker, and `base.ts` holds what both use. Paired objects talk through `SharedObject`s in `viewer/src/worker/worker_rpc.ts`.

### How a chunk gets to the screen

1. **Start-up** (`example/src/main.ts`, `viewer/src/viewer.ts`): the page chooses the store to read from: a local folder picked with the button, or the HTTP URL given as `?zarr=`. It is described by a `ZarrStoreSpec`, which is also sent to the worker. `Viewer` creates the canvas, the worker and its RPC channel, and the chunk manager, with these limits: 100 simultaneous downloads, 2 GB of system memory and 1 GB of GPU memory. The page then adds three views.
2. **Loading the volume** (`viewer/src/viewer.ts`, `viewer/src/datasource/zarr/frontend.ts`): the viewer reads the metadata of every scale, creates one chunk source per scale, sets the coordinate spaces from the volume bounds and creates the render layer.
3. **Choosing chunks** (`viewer/src/render/backend.ts`): for each view, the worker picks the scales that match the current zoom. It then finds the chunks the cross-section plane cuts through and requests them as `VISIBLE`: finer scales first, and within a scale the chunks closest to the center of the view. Chunks outside the plane are not requested ahead of time.
4. **Queueing** (`viewer/src/chunk_manager/backend.ts`): chunks are ordered by tier and priority. The highest-priority chunks are downloaded while capacity allows, and lower-priority chunks are evicted to make room.
5. **Downloading** (`viewer/src/datasource/zarr/backend.ts`, `decode.ts`): the worker reads the chunk file from the store and decodes it. A missing file is reported to the main thread (`onMissingChunk`).
6. **Upload** (`viewer/src/chunk_manager/frontend.ts`, `viewer/src/render/frontend.ts`): the chunk data is transferred to the main thread in a `Chunk.update` message. The main thread applies these updates in 30 ms time slices and uploads each chunk to a texture.
7. **Drawing** (`viewer/src/render/panel.ts`, `viewer/src/render/renderlayer.ts`): on each animation frame, every view renders its slice into an offscreen texture and then draws that texture into its part of the canvas. Only chunks already on the GPU are drawn, and finer scales are drawn over coarser ones.

### Files

#### `example/`

- `index.html`, `src/style.css`: the start screen (folder button), loading status and styles.
- `src/main.ts`: chooses the store (`?zarr=<url>` or the folder picker), creates the viewer and lays out three views side by side. It also has a commented-out line that opens Scroll 1 from the Vesuvius Challenge for testing. Start here to try the viewer API.
- `vite.config.ts`, `tsconfig.json`, `package.json`: build configuration (dev server on port 3000) and the `viewer` import described in [Using the Viewer](#using-the-viewer).

`vercel.json` at the top level builds this folder for the online demo.

#### `viewer/`

- `src/index.ts`: what the library exports: `Viewer` and its types.
- `src/viewer.ts`: `Viewer`, which connects the rest of the code (see [Using the Viewer](#using-the-viewer)).
- `package.json`: dependencies (`gl-matrix`, `numcodecs` for blosc, `es-toolkit`) and the `#src/...` import paths used inside the library.
- `tsconfig.json`: TypeScript configuration. The library needs `experimentalDecorators` and `useDefineForClassFields: false`.
- `LICENSE`, `NOTICE`: the Apache License 2.0 of Neuroglancer, and a note on how this code derives from it (see [License](#license)).

#### `viewer/src/render/`: cross-section views

- `base.ts` (main thread and worker): `ProjectionParameters` (a view's viewport plus view and projection matrices), `ChunkLayout` (the chunk grid in view coordinates), chunk specifications, `filterVisibleSources` (which scales to draw) and `forEachPlaneIntersectingVolumetricChunk` (which chunks the plane cuts through).
- `frontend.ts` (main thread): `SliceView` sends its layer and projection to the worker and draws the visible GPU chunks into an offscreen framebuffer. `DerivedProjectionParameters` recomputes a view's projection from its navigation state and viewport, and `SharedProjectionParameters` sends it to the worker. `getVolumetricTransformedSources` places each scale's chunk grid in the view. `VolumeChunkSource` and `VolumeChunk` upload chunk data to textures and free them again.
- `backend.ts` (worker): `SliceViewBackend` requests the visible chunks, using the projection received by `SharedProjectionParametersBackend`. The worker-side `VolumeChunk` holds downloaded data until it is sent to the main thread.
- `chunk_format.ts`: how a chunk is stored as a texture (one texel per voxel) and read in the fragment shader. Missing chunks share one texture filled with 0.
- `renderlayer.ts`: `ImageRenderLayer`. For each chunk it draws the polygon where the plane cuts the chunk's box (computed in the vertex shader) and maps the data value to gray.
- `panel.ts`: `DisplayContext`, the canvas and WebGL context shared by all views, which redraws them on an animation frame; and `SliceViewPanel`, which draws its slice into its region of the canvas and handles mouse input.

#### `viewer/src/chunk_manager/`: chunk lifecycle

- `base.ts`: chunk states (`QUEUED`, `DOWNLOADING`, `SYSTEM_MEMORY_WORKER`, `SYSTEM_MEMORY`, `GPU_MEMORY`, ...) and priority tiers (`VISIBLE`, `PREFETCH`, `RECENT`; nothing is requested as `PREFETCH` at the moment).
- `backend.ts` (worker): `Chunk` and `ChunkSource`; `ChunkQueueManager`, which keeps the download, system memory and GPU memory queues and moves chunks between states within capacity; and `ChunkManager`, which recomputes chunk priorities when the view changes.
- `frontend.ts` (main thread): `ChunkQueueManager` applies `Chunk.update` messages from the worker. `ChunkManager` creates each chunk source once, together with its worker counterpart.
- `README.md`: notes from the original Neuroglancer on chunk states and priority tiers.

#### `viewer/src/datasource/zarr/`: reading OME-Zarr

- `ome.ts`: parses the OME `multiscales` metadata in `.zattrs` (scales, coordinate transforms, units).
- `metadata.ts`: parses `.zarray` (shape, chunk shape, data type, compressor, dimension separator).
- `frontend.ts`: `loadZarrVolume` and `MultiscaleVolumeChunkSource`, which creates one chunk source per scale and maps zarr's (z, y, x) axis order to chunk order.
- `backend.ts` (worker): `ZarrVolumeChunkSource.download` reads one chunk file and decodes it.
- `decode.ts`: blosc or raw decoding and size check.
- `store.ts`: `ZarrStore`, where the store's files are read from: `HttpStore` (any HTTP server) or `DirectoryStore` (a local folder through the File System Access API). A `ZarrStoreSpec` describes the store so that the worker can create its own.
- `base.ts`: chunk source parameters sent to the worker (store, path of the scale's array, and metadata).

#### `viewer/src/worker/`: threads

- `chunk_worker.bundle.js`: worker entry. It loads the zarr backend and starts the RPC channel.
- `worker_rpc.ts`: `RPC` (messages between threads) and `SharedObject` (an object with a counterpart on the other thread), plus the `registerSharedObject` decorators.
- `shared_watchable_value.ts`: a value mirrored from the main thread to the worker (e.g. capacity limits).

#### `viewer/src/state/`: navigation and coordinates

- `navigation_state.ts`: `Position`, `TrackableZoom` and `NavigationState` (position, orientation and zoom, with pan, step and zoom operations).
- `coordinate_transform.ts`: `CoordinateSpace` and its bounds (voxel centers sit at integer coordinates).
- `trackable_value.ts`: `WatchableValue`, a value with a change signal.

#### `viewer/src/webgl/`: WebGL helpers

- `context.ts`: WebGL2 context setup and `gl.memoize` for shared GPU objects.
- `shader.ts`: `ShaderBuilder` and `ShaderProgram`.
- `shader_lib.ts`: GLSL types for each voxel data type.
- `texture.ts`: texture parameters and resizing.
- `buffer.ts`: vertex buffer.
- `offscreen.ts`: `OffscreenFramebuffer` (color and depth textures).
- `vertex_id.ts`: dummy vertex attribute needed by Firefox.

#### `viewer/src/util/`

- Data: `data_type.ts` (the supported data types), `array.ts`.
- `json.ts`: metadata validation and `stableStringify`.
- Priority queues for the chunk manager:
  - `pairing_heap.ts` and `linked_list.ts`: the interfaces.
  - `pairing_heap.0.ts` / `.1.ts` and `linked_list.0.ts` / `.1.ts`: two copies of each with different link fields (`next0` vs `next1`), so one chunk can sit in the system memory eviction queue and in a download or GPU queue at the same time.
- Math: `geom.ts` (gl-matrix plus helpers), `matrix.ts` (n-dimensional matrices), `vector.ts`.
- Lifetime and events: `disposable.ts` (`RefCounted`), `signal.ts`, `memoize.ts`, `object_id.ts`, `cancellation.ts`, `animation_frame_debounce.ts`.
- `si_units.ts`: unit prefixes for OME units.

## License

The code in `viewer/` is derived from [Neuroglancer](https://github.com/google/neuroglancer) and is licensed under the Apache License 2.0 (`viewer/LICENSE`). Each file derived from Neuroglancer keeps its copyright line in a one-line header; `viewer/NOTICE` describes the changes.
