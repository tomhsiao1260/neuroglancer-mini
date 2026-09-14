# Neuroglancer Mini

This is a trimmed-down version of the original Neuroglancer source code, designed to make its core logic more accessible and easier to understand. This is not a new implementation, but rather a carefully curated subset of the original codebase (~115,510 lines) that has been reduced to about ~10,500 lines by retaining only the minimal core functionality needed for the program to run, reducing npm dependencies, and simplifying the build process. This lightweight version serves as a learning demo, allowing developers to grasp the core concepts and architecture of Neuroglancer without being overwhelmed by the complexity of the original implementation.

<img width="1193" alt="img2" src="https://github.com/user-attachments/assets/c69a9014-3250-4d05-8350-abb96975b64c" />

Note: This is not an officially maintained version of Neuroglancer. Neuroglancer and Neuroglancer Mini are two independently developed projects, but this project is based on a reduced version of the original Neuroglancer source code.

# Project Structure

This project has two main branches: the [forward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/forward) and the [backward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/backward). The backward branch is a simplified version of Neuroglancer, while the forward branch builds additional features on top of this simplified version.

If you want to understand the core workings of the Neuroglancer code, you can jump to [here](#neuroglancer-mini-backward-branch). Although there isn't much information added yet, we will continue to update the content as we remove more code and gain a better understanding of the project. If you want to use the new features we've built on top of Neuroglancer Mini, you can jump to [here](#neuroglancer-mini-forward-branch).

# Neuroglancer Mini (forward branch)

You can use our additional features in the forward branch. Below we will introduce the related features and how to start the application.

<img width="1193" alt="screen-shot" src="https://github.com/user-attachments/assets/6bcf96ff-48be-4b89-a791-43e8c669027e" />

## Features

- [Coordinate Information](#coordinate-information)
- [Local First Design](#local-first-design)

### Coordinate Information

You can obtain current position information from the following sources:

- Bottom-right panel: Displays the center coordinates of the current view (in white) and the 3D coordinates of the mouse cursor (in yellow)
- URL query parameters: Includes x, y, z coordinates and zoom value

### Local First Design

We believe that the coordination between local and remote data is important, which is why we developed this feature early in the project. In this feature, data is automatically downloaded from the remote server when browsing specific areas and automatically loaded from the local storage when reopening.

Only the specific regions that have been viewed will be downloaded, and network transmission is only required the first time you view an area. This reduces dependency on network transmission. You can even write your own scripts to perform subsequent analysis on these local data.

<img width="1193" alt="zarr-file" src="https://github.com/user-attachments/assets/61ce75de-bed4-49a3-bc44-c7b144888bcd" />

## Installation & Startup

1. Make sure you are on the forward branch

```bash
git checkout forward
```

2. Install packages in the scripts folder and run the app.

```bash
cd scripts
npm install
node start.js
```

3. After completion, the application window will open. You can re-select the x, y, z coordinates you want to browse, for example:

```
http://localhost:4173/?z=6690&y=3073&x=2572&zoom=5.0
```

4. Enter the information:

- Username & Password: Please first fill out the [Vesuvius Challenge](https://scrollprize.org/data) registration form to obtain the scroll data credentials.

- Scroll URL: The remote scroll's zarr folder path, for example:

```
https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/
```

- Zarr Data Path: The local path to store zarr data. For first-time use, you can create an empty folder with the `.zarr` extension and select that path, for example:

```
E:/PATH_TO_YOUR_ZARR_FOLDER/scroll.zarr/
```

5. Click the Confirm button

The first time, data will be loaded from the remote server, which may take some time. You can find these data files in the local zarr folder you selected earlier. On subsequent visits to the same coordinates, the data will be loaded directly from your local storage.

# Neuroglancer Mini (backward branch)

The reduced architecture in the backward branch. We will continue to update the documentation as we gain more understanding of the project.

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

## Installation & Startup

The project has two parts: `client/`, the viewer (a web page), and `server/`, a small Node server that serves a local zarr store to the viewer and downloads missing files into it from a remote store. Please use Chrome or Edge.

Make sure you are on the backward branch:

```bash
git checkout backward
```

### Option 1: Client and Server (local-first)

Only the regions you look at are downloaded, and only the first time; after that they are read from your disk.

1. Install packages in the scripts folder and run the app. This installs and builds the client, starts the server, and opens the viewer.

```bash
cd scripts
npm install
node start.js
```

2. The first run creates `server/db/json/settings.json`. Set:

- `zarr_data_path`: the local `.zarr` folder to read from and download into. For a scroll you have not downloaded yet, create an empty folder, e.g. `/path/to/scroll.zarr`.
- `scroll_url_path` (optional): the remote zarr store to download missing files from, e.g. `https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr`. The Vesuvius Challenge data is public, so no username or password is needed. Leave it empty to only read local files.

3. Reload the viewer page. The server reads the settings on every request, so it does not need to be restarted.

The viewer is opened at `http://localhost:4173/?zarr=http://localhost:3005/api/data/zarr`. The server serves the files of `zarr_data_path`, and first downloads from `scroll_url_path` the files it does not have yet. Chunks neither has (sparse scrolls have many) are shown as empty and listed in the top-right corner.

### Option 2: Client Only

1. Install and start the development server:

```bash
cd client
npm install
npm run dev
```

2. Open `http://localhost:3000` and click "choose .zarr folder" to read a local `.zarr` folder through the File System Access API.

<img width="1193" alt="img1" src="https://github.com/user-attachments/assets/42784acc-39cc-4585-948b-0b2d4a971ee1" />

### Option 3: Online Demo

Visit the deployed version at [neuroglancer-mini.vercel.app](https://neuroglancer-mini.vercel.app)

### Supported Data

The viewer opens one OME-Zarr multiscale volume stored as Zarr v2. The page's URL parameters choose where it comes from:

- No parameters: click "choose .zarr folder" and pick the `.zarr` folder itself (the one containing `.zattrs`).
- `?zarr=<url>`: read the files over HTTP, where `<url>` is the URL of the `.zarr` folder. Any server that returns the files (and 404 for missing ones) works if it allows cross-origin requests (CORS): the server in `server/`, a static server such as `npx http-server <folder containing scroll.zarr> -p 9000 --cors`, or the Vesuvius Challenge data server itself (without saving anything locally).

- Metadata: `.zattrs` with OME `multiscales`, and a `.zarray` for each scale (C order).
- Compressors: blosc and null (raw).
- Data types: uint8, int8, uint16, int16, uint32, int32, uint64 (8-byte integers are read as unsigned) and float32, little or big endian.
- Chunk keys may use either `.` or `/` as the dimension separator. Chunks missing from the store are shown as 0.

The volume is shown in three cross-section panels (XY, YZ and XZ) that share one position and zoom. Drag with the left mouse button to pan, use the wheel to step one voxel through the slice, and hold Ctrl while using the wheel to zoom around the cursor.

## Project Structure

The code is split between two threads. The **main thread** owns the WebGL canvas, the three panels and mouse input. A **worker** (`client/src/worker/chunk_worker.bundle.js`) decides which chunks are needed, reads and decodes them, and keeps them within memory limits. Most modules therefore come in pairs: `frontend.ts` runs on the main thread, `backend.ts` runs in the worker, and `base.ts` holds what both use. Paired objects talk through `SharedObject`s in `client/src/worker/worker_rpc.ts`.

### How a chunk gets to the screen

1. **Start-up** (`client/src/main.ts`): the store to read from is chosen: a local folder picked with the button, or the HTTP URL given as `?zarr=`. It is described by a `ZarrStoreSpec`, which is also sent to the worker. `client/src/viewer.ts` creates the canvas, the worker and its RPC channel, and the chunk manager, with these limits: 100 simultaneous downloads, 2 GB of system memory and 1 GB of GPU memory. `main.ts` then adds three views.
2. **Loading the volume** (`client/src/main.ts`, `client/src/datasource/zarr/frontend.ts`): the viewer reads the metadata of every scale, creates one chunk source per scale, sets the coordinate spaces from the volume bounds and creates the render layer.
3. **Choosing chunks** (`client/src/render/backend.ts`): for each panel, the worker picks the scales that match the current zoom. It then finds the chunks the cross-section plane cuts through and requests them as `VISIBLE`. The prefetching code, which would request chunks ahead of the current motion as `PREFETCH`, currently requests nothing: the transform it uses to turn motion into chunk coordinates (`combinedGlobalLocalToChunkTransform`) is never filled in.
4. **Queueing** (`client/src/chunk_manager/backend.ts`): chunks are ordered by tier and priority. The highest-priority chunks are downloaded while capacity allows, and lower-priority chunks are evicted to make room.
5. **Downloading** (`client/src/datasource/zarr/backend.ts`, `decode.ts`): the worker reads the chunk file from the store and decodes it.
6. **Upload** (`client/src/chunk_manager/frontend.ts`, `client/src/render/frontend.ts`): the chunk data is transferred to the main thread in a `Chunk.update` message. The main thread applies these updates in 30 ms time slices and uploads each chunk to a texture.
7. **Drawing** (`client/src/render/panel.ts`, `client/src/render/renderlayer.ts`): on each animation frame, every panel renders its slice into an offscreen texture and then draws that texture into its part of the canvas. Only chunks already on the GPU are drawn, and finer scales are drawn over coarser ones.

### Files

#### Entry

- `index.html`, `client/src/style.css`: page and styles.
- `client/src/main.ts`: the app. Chooses the store (`?zarr=<url>` or the folder picker), creates the viewer, lays out three views side by side and adds the features in `client/src/app/`. Start here to change what the page shows.
- `client/src/viewer.ts`: `Viewer`, the interface to the rest of the code.
  - `new Viewer({ container, store })` creates the canvas, the worker and the chunk manager and loads the volume; `viewer.loaded` resolves once it has loaded.
  - `viewer.addView(element, "xy" | "xz" | "yz")` shows a cross-section in `element`, which can be placed anywhere inside the container with CSS, and returns the view; `view.dispose()` removes it. All views share one position and zoom.
  - `viewer.position` / `viewer.setPosition({ x, y, z })` and `viewer.zoom` / `viewer.setZoom(voxelsPerPixel)` read and change the view; `viewer.onViewChanged(callback)` and `viewer.onPointerMove(callback)` report changes of the view and of the point under the pointer. Points are in full-resolution voxels, with `x`, `y`, `z` along the last, middle and first zarr dimensions; voxel `(i, j, k)` is centered on `{ x: i, y: j, z: k }`.
  - `new Viewer({ ..., onMissingChunk })` is called with `{ key }` (e.g. `0/52/24/18`) for each chunk whose file is not in the store, once per chunk while the viewer is open. If it returns (or resolves to) `true`, the file is assumed to have been added and the chunk is downloaded again; otherwise the chunk is shown as empty. A downloader can be plugged in here without changing the viewer.
- `client/src/app/missing_chunks.ts`: the default `onMissingChunk` handler; lists missing chunks in the top-right corner and leaves them empty.
- `client/src/app/position_display.ts`: shows the voxel under the pointer (yellow) and at the center of the views (white) in the bottom-right corner.
- `client/src/app/url_position.ts`: keeps `x`, `y`, `z` and `zoom` in the page URL, and moves there when the page is opened with them.

#### `client/src/render/`: cross-section views

- `base.ts` (main thread and worker): `ProjectionParameters` (a panel's viewport plus view and projection matrices), `ChunkLayout` (the chunk grid in view coordinates), chunk specifications, `filterVisibleSources` (which scales to draw) and `forEachPlaneIntersectingVolumetricChunk` (which chunks the plane cuts through).
- `frontend.ts` (main thread): `SliceView` sends its layer and projection to the worker and draws the visible GPU chunks into an offscreen framebuffer. `DerivedProjectionParameters` recomputes a panel's projection from its navigation state and viewport, and `SharedProjectionParameters` sends it to the worker. `getVolumetricTransformedSources` places each scale's chunk grid in the view. `VolumeChunkSource` and `VolumeChunk` upload chunk data to textures and free them again.
- `backend.ts` (worker): `SliceViewBackend` requests the visible chunks, using the projection received by `SharedProjectionParametersBackend`. The worker-side `VolumeChunk` holds downloaded data until it is sent to the main thread.
- `chunk_format.ts`: how a chunk is stored as a texture (one texel per voxel) and read in the fragment shader. Missing chunks share one texture filled with 0.
- `renderlayer.ts`: `ImageRenderLayer`. For each chunk it draws the polygon where the plane cuts the chunk's box (computed in the vertex shader) and maps the data value to gray.
- `panel.ts`: `DisplayContext`, the canvas and WebGL context shared by all panels, which redraws them on an animation frame; and `SliceViewPanel`, which draws its slice into its region of the canvas and handles mouse input.

#### `client/src/chunk_manager/`: chunk lifecycle

- `base.ts`: chunk states (`QUEUED`, `DOWNLOADING`, `SYSTEM_MEMORY_WORKER`, `SYSTEM_MEMORY`, `GPU_MEMORY`, ...) and priority tiers (`VISIBLE`, `PREFETCH`, `RECENT`).
- `backend.ts` (worker): `Chunk` and `ChunkSource`; `ChunkQueueManager`, which keeps the download, system memory and GPU memory queues and moves chunks between states within capacity; and `ChunkManager`, which recomputes chunk priorities when the view changes.
- `frontend.ts` (main thread): `ChunkQueueManager` applies `Chunk.update` messages from the worker. `ChunkManager` creates each chunk source once, together with its worker counterpart.
- `README.md`: notes from the original Neuroglancer on chunk states and priority tiers.

#### `client/src/datasource/zarr/`: reading OME-Zarr

- `ome.ts`: parses the OME `multiscales` metadata in `.zattrs` (scales, coordinate transforms, units).
- `metadata.ts`: parses `.zarray` (shape, chunk shape, data type, compressor, dimension separator).
- `frontend.ts`: `loadZarrVolume` and `MultiscaleVolumeChunkSource`, which creates one chunk source per scale and maps zarr's (z, y, x) axis order to chunk order.
- `backend.ts` (worker): `ZarrVolumeChunkSource.download` reads one chunk file and decodes it.
- `decode.ts`: blosc or raw decoding, size check and endianness conversion.
- `store.ts`: `ZarrStore`, where the store's files are read from: `HttpStore` (any HTTP server) or `DirectoryStore` (a local folder through the File System Access API). A `ZarrStoreSpec` describes the store so that the worker can create its own.
- `base.ts`: chunk source parameters sent to the worker (store, path of the scale's array, and metadata).

`client/src/datasource/file_protocols.md` and `client/src/datasource/zarr/README.md` are notes from the original Neuroglancer and describe more protocols and formats than this version supports.

#### `client/src/worker/`: threads

- `chunk_worker.bundle.js`: worker entry. It loads the zarr backend and starts the RPC channel.
- `worker_rpc.ts`: `RPC` (messages between threads) and `SharedObject` (an object with a counterpart on the other thread), plus the `registerSharedObject` decorators.
- `shared_watchable_value.ts`: a value mirrored from the main thread to the worker (e.g. capacity limits).

#### `client/src/state/`: navigation and coordinates

- `navigation_state.ts`: `Position`, `TrackableZoom` and `NavigationState` (position, orientation and zoom, with pan, step and zoom operations).
- `coordinate_transform.ts`: `CoordinateSpace` and its bounds (voxel centers sit at integer coordinates).
- `trackable_value.ts`: `WatchableValue`, a value with a change signal.

#### `client/src/webgl/`: WebGL helpers

- `context.ts`: WebGL2 context setup and `gl.memoize` for shared GPU objects.
- `shader.ts`: `ShaderBuilder` and `ShaderProgram`.
- `shader_lib.ts`: GLSL types for each voxel data type.
- `texture.ts`: texture parameters and resizing.
- `buffer.ts`: vertex buffer.
- `offscreen.ts`: `OffscreenFramebuffer` (color and depth textures).
- `vertex_id.ts`: dummy vertex attribute needed by Firefox.

#### `client/src/util/`

- Data: `data_type.ts`, `numpy_dtype.ts`, `endian.ts`, `array.ts`.
- `json.ts`: metadata validation and `stableStringify`.
- Priority queues for the chunk manager:
  - `pairing_heap.ts` and `linked_list.ts`: the interfaces.
  - `pairing_heap.0.ts` / `.1.ts` and `linked_list.0.ts` / `.1.ts`: two copies of each with different link fields (`next0` vs `next1`), so one chunk can sit in the system memory eviction queue and in a download or GPU queue at the same time.
- Math: `geom.ts` (gl-matrix plus helpers), `matrix.ts` (n-dimensional matrices), `vector.ts`, `erf.ts`, `velocity_estimation.ts` (motion estimate used for prefetching).
- Lifetime and events: `disposable.ts` (`RefCounted`), `signal.ts`, `memoize.ts`, `object_id.ts`, `cancellation.ts`, `animation_frame_debounce.ts`.
- `si_units.ts`: unit prefixes for OME units.

#### Client Build Configuration

- `client/vite.config.ts`: Vite build configuration (dev server on port 3000, build output in `build/client/page`, ES module worker).
- `client/tsconfig.json`: TypeScript configuration.
- `client/package.json`: dependencies (`gl-matrix`, `numcodecs` for blosc, `es-toolkit`) and scripts.

#### `server/`: local-first zarr store (Node, Express)

- `src/index.ts`: starts the server on port 3005 (or `PORT`).
- `src/routes/data.ts`: `GET /api/data/zarr/<key>` serves a file of the local store. A file the local store does not have is first downloaded from the remote store, if one is set; a file neither has answers 404.
- `src/utils/download.ts`: downloads one file, writing it under a temporary name first so that a partly written file is never served.
- `src/utils/settings.ts`: the settings in `db/json/settings.json`: `zarr_data_path` (the local `.zarr` folder) and `scroll_url_path` (the remote store, optional).

#### `scripts/`

- `start.js`: installs and builds the client, starts the client preview (port 4173) and the server, and opens the viewer once both are running.
