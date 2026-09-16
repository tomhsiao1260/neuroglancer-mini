# Neuroglancer Mini

A reduced copy of the [Neuroglancer](https://github.com/google/neuroglancer) source that views OME-Zarr volumes as cross-sections: about 138,000 lines of TypeScript and JavaScript under its `src/` (tests excluded) down to about 6,950 lines. `viewer/` is the library, `example/` is a demo page that uses it.

The chunk state machine, priority tiers, multiscale selection, prefetching, the worker split and the WebGL slice rendering are all still there. What is not needed to put one volume on the screen is gone. At this size the whole path can be read end to end: which chunks are downloaded, in what order, and how they reach a texture.

I packaged the reduced code as a library rather than an application, so it has no interface of its own. You give it a container and the elements to draw into, and it does the loading and the rendering. The interface is left to whatever is built on top: a labelling tool, a segmentation browser, a downloader that fetches only what is on screen. The [forward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/forward) is one of those.

This is my own fork, not a Neuroglancer official release. The code in `viewer/` stays under Apache 2.0 (see [License](#license)).

## Motivation

I wanted to know how Neuroglancer loads the data: what it downloads, in what order, and how a slice ends up on the screen. Reading the original is frustrated because the loading path runs through layers of abstraction that exist for segmentations, meshes, annotations and a dozen data sources. So I removed the rest, one verifiable step at a time, and documented what was left.

## Usage

```bash
cd example
npm install          # also installs viewer/
npm run dev          # http://localhost:3000
```

"Open local folder" reads a `.zarr` folder from disk (File System Access API, Chrome or Edge). To read it over HTTP instead, serve the folder and pass its URL as `?zarr=`:

```bash
npx http-server <folder containing scroll.zarr> -p 9000 --cors
# http://localhost:3000/?zarr=http://localhost:9000/scroll.zarr
```

Left drag pans, the wheel steps one voxel along the viewing direction, Ctrl + wheel zooms at the cursor.

A build of `example/` also runs at [neuroglancer-mini.vercel.app](https://neuroglancer-mini.vercel.app) and takes the same `?zarr=` parameter, so a volume on a remote server can be opened without installing anything. Pointing it at a full scroll on the data server is slow and still untested, so local data is the better way to try it for now.

## Library

```ts
import { NavigationGroup, Viewer } from "viewer";

const viewer = new Viewer({ container });
const volume = viewer.addVolume({ kind: "http", url });
const navigation = new NavigationGroup(volume);
viewer.addView(leftElement, { volume, orientation: "xy", navigation });
viewer.addView(rightElement, { volume, orientation: "yz", navigation });
await volume.loaded;
navigation.setPosition({ x: 3000, y: 3000, z: 7000 });
```

- `new Viewer({ container })` creates the WebGL context, the worker and the chunk manager. View elements must lie inside the container.
- `addVolume(store, { onMissingChunk? })` starts loading a volume; `store` is `{ kind: "http", url }` or `{ kind: "directory", handle }`, and `volume.loaded` resolves when its metadata is read. A viewer can hold several volumes, sharing one worker and one set of memory limits.
- `new NavigationGroup(volume)` is a position and a zoom, with `position` / `setPosition({ x, y, z })`, `zoom` / `setZoom(voxelsPerPixel)` and `onViewChanged(cb)`. The volume it is created with fixes the coordinates. Points are in full-resolution voxels; `x`, `y`, `z` are the last, middle and first zarr dimensions, and voxel `(i, j, k)` is centered on `{ x: i, y: j, z: k }`.
- `addView(element, { volume, orientation, navigation })` draws a cross-section in a canvas of its own inside the element; any CSS layout works. Views given the same group show the same place and move together; a view of its own gets a group of its own. Views can be added and removed at runtime, and `view.dispose()` removes one. A view whose element is moved rather than resized needs `viewer.invalidateBounds()`, and a CSS transform that magnifies a view shows the same data larger rather than more data.
- `onMissingChunk({ key })` is called once per chunk file that is not in the store. Return `true` once the file has been added and the chunk is fetched again. The forward branch uses this to download a scroll lazily.
- `isReady()` is true when every view has all of its chunks on the GPU. `chunkManager.chunkQueueManager.enablePrefetch.value = false` requests only what is visible, and `logStatistics.value = true` logs chunk counts and memory use from the worker.
- `view.handleInput` can decline any mouse event, so the page can use it for something of its own, and `view.stepSlices`, `view.translateByViewportPixels`, `view.zoomByMouse` and `view.pointAt` then drive the slice instead.

For another Vite app, put `viewer/` next to it and copy from `example/`: the `viewer` alias plus `server.fs.allow: [".."]` and `worker.format: "es"` in `vite.config.ts`, the same `paths` entry in `tsconfig.json`, and `"postinstall": "npm install --prefix ../viewer"`.

## Data

One OME-Zarr 0.4 multiscale volume, zarr v2:

- Axes `z`, `y`, `x` in that order; `scale`, `translation` and `identity` transforms.
- `|u1`, `<u2`, `<f4` (float32 is shown over [0, 1]), C order, blosc or no compressor, `.` or `/` separator.
- Read over HTTP (CORS required) or from a local folder.

This covers the scroll and fragment volumes on the data server, and float32 surface data such as tifxyz. Anything else fails with an error instead of being drawn wrongly.

A chunk file that is missing is drawn with the array's `fill_value` and reported through `onMissingChunk`. A chunk that cannot be read or decoded fails, and the coarser scale under it shows through.

## How it works

Two threads. The main thread owns the canvas, the views and mouse input. A worker decides which chunks are needed, reads and decodes them and keeps them within the memory limits; it hands blosc decompression to a pool of further workers. Modules come in pairs: `frontend.ts` on the main thread, `backend.ts` in the worker, `base.ts` for what both use, talking through `SharedObject`s (`viewer/src/worker/worker_rpc.ts`).

1. **Start-up** (`viewer/src/viewer.ts`). The store is described by a `ZarrStoreSpec`, which is also sent to the worker. Limits: 100 simultaneous downloads, 2 GB system memory, 1 GB GPU memory.
2. **Metadata** (`datasource/zarr/frontend.ts`, `ome.ts`). Each scale's OME transforms become a voxel size and an origin in full-resolution voxels, and each scale becomes one chunk source, shared by all views.
3. **Chunk selection** (`render/backend.ts`). Per view, `filterVisibleSources` picks the scales for the current pixel size; the chunks the plane cuts through are requested as `VISIBLE`, coarsest scale first and nearest the center of the view first. A velocity estimate (`util/velocity_estimation.ts`, `util/erf.ts`) adds the chunks the view is likely to reach within two seconds as `PREFETCH`. A view that is off screen and not near its container requests nothing; one that is only near it requests at the `PREFETCH` tier.
4. **Queueing** (`chunk_manager/backend.ts`). Chunks carry a tier (`VISIBLE`, `PREFETCH`, `RECENT`) and a priority, and move through `QUEUED → DOWNLOADING → SYSTEM_MEMORY_WORKER → GPU_MEMORY` while capacity allows, evicting lower-priority chunks. Chunks that are no longer requested drop to `RECENT` and are kept in LRU order. Priorities are recomputed on every view change and every 200 ms while chunks keep moving to or from the GPU, so the velocity estimate decays when the view stops.
5. **Download** (`datasource/zarr/backend.ts`, `store.ts`). One chunk file per request; 429, 503 and 504 are retried with increasing delays. A cancelled download is aborted at the network level and leaves the chunk object alone, since it may already have been recycled.
6. **Upload** (`chunk_manager/frontend.ts`). Chunk data is transferred to the main thread in a `Chunk.update` message and uploaded to a 3-D texture in 30 ms time slices. While the view moves, uploads start only within 10 ms of a change and otherwise wait for the next frame.
7. **Draw** (`render/renderlayer.ts`, `render/panel.ts`). Per chunk on the GPU, the vertex shader computes the polygon where the plane cuts the chunk's box and the fragment shader samples the texture. Finer scales draw over coarser ones, with the depth buffer keeping the coarse fill-in behind them. All views draw into one WebGL surface that is not in the page, one after another, and each copies its own rectangle into a canvas inside its element — so a view is an ordinary element that can be styled, stacked and clipped.

## Code map

- `render/`: cross-section views. `base.ts` (projection parameters, chunk layout, chunk specification, scale selection, plane–chunk iteration), `frontend.ts` (`SliceView`, textures), `backend.ts` (chunk requests), `chunk_format.ts` (chunk as a 3-D texture; missing chunks share one fill-value texture), `renderlayer.ts` (the shaders), `panel.ts` (the shared WebGL surface, each view's own canvas, mouse input, visibility).
- `chunk_manager/`: `base.ts` (states, tiers, capacities), `backend.ts` (`Chunk`, `ChunkSource`, the queues, priority recomputation), `frontend.ts` (`Chunk.update` handling, shared chunk sources). `README.md` is the original Neuroglancer note on states and tiers.
- `datasource/zarr/`: `ome.ts`, `metadata.ts`, `frontend.ts`, `backend.ts`, `decode.ts`, `store.ts` (`HttpStore`, `DirectoryStore`).
- `worker/`: `chunk_worker.bundle.js`, the decode pool (`decode_pool.ts`, `decode_blosc.ts`, `decode_worker.bundle.js`, up to `min(12, cores)` workers), `worker_rpc.ts`, `shared_watchable_value.ts`.
- `state/`: position, zoom, orientation, coordinate space. `webgl/`: context, shader building, textures, buffers. `util/`: pairing heap and linked list for the queues, velocity estimation, geometry, JSON validation, reference counting, signals.

## Not included

Segmentation, annotation, mesh and skeleton layers, 3-D volume rendering, the user interface and shareable state, the Python integration, the other data sources and codecs, and the abstractions that supported them: multiple layers per viewer, per-layer coordinate transforms, the generic chunk-source machinery.

Three places are deliberately narrower than the original:

- The axes must be exactly `(z, y, x)`; a time or channel axis is rejected rather than mapped wrongly.
- A network or CORS error fails the chunk. In the original an unreadable file is an empty chunk; here "missing" means the store answered 404, so `onMissingChunk` means the file is not there.
- One volume in one layer per viewer.

The three orientations are a limit of the example API, not of the code: views are built from a rotation and the rendering path handles an arbitrary plane.

## Development

```bash
cd viewer && npx tsc --noEmit    # clean
cd example && npm run build
```

Each reduction step kept the picture and the set of requested chunk files identical to the step before it, checked in headless Chrome against scroll data. The same rule is worth keeping: compare screenshots and requested files with prefetching off, using `isReady()` to know when a view is complete.

## Branches

- **backward** (this readme, merged into `main`): the reduced code and the example page.
- **[forward](https://github.com/tomhsiao1260/neuroglancer-mini/tree/forward)**: an app on the same `viewer/` folder, with a Node server that downloads only the parts of a scroll you look at, coordinate display, positions in the URL and a list of missing chunks. Its [notes on a board of cross-section cards](https://github.com/tomhsiao1260/neuroglancer-mini/blob/forward/docs/whiteboard.md) record which parts of `viewer/` that direction depends on; worth reading before reducing the code further.

## License

`viewer/` is derived from Neuroglancer and licensed under the Apache License 2.0 (`viewer/LICENSE`). Each derived file keeps its copyright line in a one-line header; `viewer/NOTICE` describes the changes.
