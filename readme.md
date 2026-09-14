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

This lightweight demo uses the File System Access API to load data directly from your local filesystem. This API is currently not supported in some browsers. Please use Chrome or Edge to run this project.

<img width="1193" alt="img1" src="https://github.com/user-attachments/assets/42784acc-39cc-4585-948b-0b2d4a971ee1" />

### Option 1: Local Development

1. Make sure you are on the backward branch

```bash
git checkout backward
```

2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000` in Chrome or Edge

### Option 2: Online Demo

Visit the deployed version at [neuroglancer-mini.vercel.app](https://neuroglancer-mini.vercel.app)

### Supported Data

The viewer opens one OME-Zarr multiscale volume stored as Zarr v2. Click "choose .zarr folder" and pick the `.zarr` folder itself (the one containing `.zattrs`); files are then read from that folder through the File System Access API.

- Metadata: `.zattrs` with OME `multiscales`, and a `.zarray` for each scale (C order).
- Compressors: blosc and null (raw).
- Data types: uint8, int8, uint16, int16, uint32, int32, uint64 (8-byte integers are read as unsigned) and float32, little or big endian.
- Chunk keys may use either `.` or `/` as the dimension separator. Chunks missing from the store are shown as 0.

The volume is shown in three cross-section panels (XY, YZ and XZ) that share one position and zoom. Drag with the left mouse button to pan, use the wheel to step one voxel through the slice, and hold Ctrl while using the wheel to zoom around the cursor.

## Project Structure

The code is split between two threads. The **main thread** owns the WebGL canvas, the three panels and mouse input. A **worker** (`src/worker/chunk_worker.bundle.js`) decides which chunks are needed, reads and decodes them, and keeps them within memory limits. Most modules therefore come in pairs: `frontend.ts` runs on the main thread, `backend.ts` runs in the worker, and `base.ts` holds what both use. Paired objects talk through `SharedObject`s in `src/worker/worker_rpc.ts`.

### How a chunk gets to the screen

1. **Start-up** (`src/main.ts`): the chosen folder is turned into a file tree, which is sent to the worker once it reports ready. `main.ts` also creates the canvas, the worker and its RPC channel, and the chunk manager, with these limits: 100 simultaneous downloads, 2 GB of system memory and 1 GB of GPU memory. It then creates the three panels.
2. **Loading the volume** (`src/main.ts`, `src/datasource/zarr/frontend.ts`): the viewer reads the metadata of every scale, creates one chunk source per scale, sets the coordinate spaces from the volume bounds and creates the render layer.
3. **Choosing chunks** (`src/render/backend.ts`): for each panel, the worker picks the scales that match the current zoom. It then finds the chunks the cross-section plane cuts through and requests them as `VISIBLE`. The prefetching code, which would request chunks ahead of the current motion as `PREFETCH`, currently requests nothing: the transform it uses to turn motion into chunk coordinates (`combinedGlobalLocalToChunkTransform`) is never filled in.
4. **Queueing** (`src/chunk_manager/backend.ts`): chunks are ordered by tier and priority. The highest-priority chunks are downloaded while capacity allows, and lower-priority chunks are evicted to make room.
5. **Downloading** (`src/datasource/zarr/backend.ts`, `decode.ts`): the worker reads the chunk file from the file tree and decodes it.
6. **Upload** (`src/chunk_manager/frontend.ts`, `src/render/frontend.ts`): the chunk data is transferred to the main thread in a `Chunk.update` message. The main thread applies these updates in 30 ms time slices and uploads each chunk to a texture.
7. **Drawing** (`src/render/panel.ts`, `src/render/renderlayer.ts`): on each animation frame, every panel renders its slice into an offscreen texture and then draws that texture into its part of the canvas. Only chunks already on the GPU are drawn, and finer scales are drawn over coarser ones.

### Files

#### Entry

- `index.html`, `src/style.css`: page and styles.
- `src/main.ts`: folder picker, the worker and chunk manager, the viewer (loads the volume and creates the render layer) and the three panels.

#### `src/render/`: cross-section views

- `base.ts` (main thread and worker): `ProjectionParameters` (a panel's viewport plus view and projection matrices), `ChunkLayout` (the chunk grid in view coordinates), chunk specifications, `filterVisibleSources` (which scales to draw) and `forEachPlaneIntersectingVolumetricChunk` (which chunks the plane cuts through).
- `frontend.ts` (main thread): `SliceView` sends its layer and projection to the worker and draws the visible GPU chunks into an offscreen framebuffer. `DerivedProjectionParameters` recomputes a panel's projection from its navigation state and viewport, and `SharedProjectionParameters` sends it to the worker. `getVolumetricTransformedSources` places each scale's chunk grid in the view. `VolumeChunkSource` and `VolumeChunk` upload chunk data to textures and free them again.
- `backend.ts` (worker): `SliceViewBackend` requests the visible chunks, using the projection received by `SharedProjectionParametersBackend`. The worker-side `VolumeChunk` holds downloaded data until it is sent to the main thread.
- `chunk_format.ts`: how a chunk is stored as a texture (one texel per voxel) and read in the fragment shader. Missing chunks share one texture filled with 0.
- `renderlayer.ts`: `ImageRenderLayer`. For each chunk it draws the polygon where the plane cuts the chunk's box (computed in the vertex shader) and maps the data value to gray.
- `panel.ts`: `DisplayContext`, the canvas and WebGL context shared by all panels, which redraws them on an animation frame; and `SliceViewPanel`, which draws its slice into its region of the canvas and handles mouse input.

#### `src/chunk_manager/`: chunk lifecycle

- `base.ts`: chunk states (`QUEUED`, `DOWNLOADING`, `SYSTEM_MEMORY_WORKER`, `SYSTEM_MEMORY`, `GPU_MEMORY`, ...) and priority tiers (`VISIBLE`, `PREFETCH`, `RECENT`).
- `backend.ts` (worker): `Chunk` and `ChunkSource`; `ChunkQueueManager`, which keeps the download, system memory and GPU memory queues and moves chunks between states within capacity; and `ChunkManager`, which recomputes chunk priorities when the view changes.
- `frontend.ts` (main thread): `ChunkQueueManager` applies `Chunk.update` messages from the worker. `ChunkManager` creates each chunk source once, together with its worker counterpart.
- `README.md`: notes from the original Neuroglancer on chunk states and priority tiers.

#### `src/datasource/zarr/`: reading OME-Zarr

- `ome.ts`: parses the OME `multiscales` metadata in `.zattrs` (scales, coordinate transforms, units).
- `metadata.ts`: parses `.zarray` (shape, chunk shape, data type, compressor, dimension separator).
- `frontend.ts`: `loadZarrVolume` and `MultiscaleVolumeChunkSource`, which creates one chunk source per scale and maps zarr's (z, y, x) axis order to chunk order.
- `backend.ts` (worker): `ZarrVolumeChunkSource.download` reads one chunk file and decodes it.
- `decode.ts`: blosc or raw decoding, size check and endianness conversion.
- `base.ts`: chunk source parameters sent to the worker (URL and metadata).

`src/datasource/file_protocols.md` and `src/datasource/zarr/README.md` are notes from the original Neuroglancer and describe more protocols and formats than this version supports.

#### `src/worker/`: threads

- `chunk_worker.bundle.js`: worker entry. It loads the zarr backend and starts the RPC channel.
- `worker_rpc.ts`: `RPC` (messages between threads) and `SharedObject` (an object with a counterpart on the other thread), plus the `registerSharedObject` decorators.
- `shared_watchable_value.ts`: a value mirrored from the main thread to the worker (e.g. capacity limits).

#### `src/state/`: navigation and coordinates

- `navigation_state.ts`: `Position`, `TrackableZoom` and `NavigationState` (position, orientation and zoom, with pan, step and zoom operations).
- `coordinate_transform.ts`: `CoordinateSpace` and its bounds (voxel centers sit at integer coordinates).
- `trackable_value.ts`: `WatchableValue`, a value with a change signal.

#### `src/webgl/`: WebGL helpers

- `context.ts`: WebGL2 context setup and `gl.memoize` for shared GPU objects.
- `shader.ts`: `ShaderBuilder` and `ShaderProgram`.
- `shader_lib.ts`: GLSL types for each voxel data type.
- `texture.ts`: texture parameters and resizing.
- `buffer.ts`: vertex buffer.
- `offscreen.ts`: `OffscreenFramebuffer` (color and depth textures).
- `vertex_id.ts`: dummy vertex attribute needed by Firefox.

#### `src/util/`

- Data: `data_type.ts`, `numpy_dtype.ts`, `endian.ts`, `array.ts`.
- Files:
  - `file_system.ts`: reads the chosen folder into a file tree.
  - `http_request.ts`: looks a URL's path up in the file tree. The first path segment (the `.zarr` folder name) is dropped.
  - `file_reader.ts`: reads one chunk file; a missing chunk returns `undefined`.
  - `json.ts`: metadata validation and `stableStringify`.
- Priority queues for the chunk manager:
  - `pairing_heap.ts` and `linked_list.ts`: the interfaces.
  - `pairing_heap.0.ts` / `.1.ts` and `linked_list.0.ts` / `.1.ts`: two copies of each with different link fields (`next0` vs `next1`), so one chunk can sit in the system memory eviction queue and in a download or GPU queue at the same time.
- Math: `geom.ts` (gl-matrix plus helpers), `matrix.ts` (n-dimensional matrices), `vector.ts`, `erf.ts`, `velocity_estimation.ts` (motion estimate used for prefetching).
- Lifetime and events: `disposable.ts` (`RefCounted`), `signal.ts`, `memoize.ts`, `object_id.ts`, `cancellation.ts`, `animation_frame_debounce.ts`.
- `si_units.ts`: unit prefixes for OME units.

#### Build Configuration

- `vite.config.ts`: Vite build configuration (dev server on port 3000, ES module worker).
- `tsconfig.json`: TypeScript configuration.
- `package.json`: dependencies (`gl-matrix`, `numcodecs` for blosc, `es-toolkit`) and scripts.
