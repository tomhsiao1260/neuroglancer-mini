# Neuroglancer Mini (forward branch)

This branch builds an app on top of Neuroglancer Mini, a trimmed-down version of the Neuroglancer source code. The viewer itself lives in `viewer/`, which is the same folder as in the [backward branch](https://github.com/tomhsiao1260/neuroglancer-mini/tree/backward). For how the viewer works, its API and its source files, see the [main README](https://github.com/tomhsiao1260/neuroglancer-mini#readme).

<img width="1193" alt="screen-shot" src="https://github.com/user-attachments/assets/6bcf96ff-48be-4b89-a791-43e8c669027e" />

## Features

- [Coordinate Information](#coordinate-information)
- [Local First Design](#local-first-design)
- [Missing Chunks](#missing-chunks)

### Coordinate Information

You can obtain current position information from the following sources:

- Bottom-right panel: Displays the voxel under the mouse cursor (in yellow) and the voxel at the center of the views (in white)
- URL query parameters: `x`, `y`, `z` (the center, in full-resolution voxels) and `zoom` (voxels per screen pixel). Opening a URL with them moves the views there.

### Local First Design

We believe that the coordination between local and remote data is important, which is why we developed this feature early in the project. In this feature, data is automatically downloaded from the remote server when browsing specific areas and automatically loaded from the local storage when reopening.

Only the specific regions that have been viewed will be downloaded, and network transmission is only required the first time you view an area. This reduces dependency on network transmission. You can even write your own scripts to perform subsequent analysis on these local data.

<img width="1193" alt="zarr-file" src="https://github.com/user-attachments/assets/61ce75de-bed4-49a3-bc44-c7b144888bcd" />

### Missing Chunks

Chunks that neither the local folder nor the remote store has (sparse scrolls have many) are shown as empty and listed in the top-right corner.

## Installation & Startup

1. Make sure you are on the forward branch

```bash
git checkout forward
```

2. Install packages in the scripts folder and run the app. This installs and builds the client, starts the server, and opens the page once both are running.

```bash
cd scripts
npm install
node start.js
```

3. Enter the information:

- Scroll URL (optional): The remote scroll's zarr folder, for example the one below. The Vesuvius Challenge data is public, so no username or password is needed. Leave it empty to only read local files.

```
https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/
```

- Zarr Data Path: The local path to store zarr data. For first-time use, you can create an empty folder with the `.zarr` extension and select that path, for example:

```
E:/PATH_TO_YOUR_ZARR_FOLDER/scroll.zarr/
```

4. Click the Confirm button. The settings are saved in `server/db/json/settings.json`.

The first time, data will be loaded from the remote server, which may take some time. You can find these data files in the local zarr folder you selected earlier. On subsequent visits to the same coordinates, the data will be loaded directly from your local storage. To open a specific place, add the coordinates to the URL, for example:

```
http://localhost:4173/?x=2572&y=3073&z=6690&zoom=2
```

## Project Structure

- `viewer/`: the viewer library. Keep it identical to the backward branch; its files are described in the [main README](https://github.com/tomhsiao1260/neuroglancer-mini#project-structure).
- `client/`: the app page (Vite, Tailwind).
  - `index.html`: the settings form, the loading overlay and the viewer container.
  - `src/main.ts`: reads and saves the settings through the server, then creates the viewer, lays out three views and adds the features in `src/app/`.
  - `src/app/position_display.ts`: the coordinate panel in the bottom-right corner.
  - `src/app/url_position.ts`: keeps `x`, `y`, `z` and `zoom` in the URL.
  - `src/app/missing_chunks.ts`: the `onMissingChunk` handler that lists missing chunks.
  - `src/config.ts`: the server address.
  - `vite.config.ts`, `tsconfig.json`, `package.json`: build configuration (output in `build/client/page`) and the `viewer` import, set up as in the backward branch's `example/`.
- `server/`: local-first zarr store (Node, Express), on port 3005.
  - `src/routes/data.ts`: `GET /api/data/zarr/<key>` serves a file of the local store. A file the local store does not have is first downloaded from the remote store, if one is set; a file neither has answers 404.
  - `src/routes/settings.ts`: `GET /api/settings` reads the settings and `POST /api/settings` changes them.
  - `src/utils/download.ts`: downloads one file, writing it under a temporary name first so that a partly written file is never served.
  - `src/utils/settings.ts`: the settings in `db/json/settings.json`: `zarr_data_path` (the local `.zarr` folder) and `scroll_url_path` (the remote store, optional).
- `scripts/start.js`: installs and builds the client, starts the client preview (port 4173) and the server, and opens the page once both are running.
