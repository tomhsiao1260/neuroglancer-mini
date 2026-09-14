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
 * @file The app: chooses where the volume is read from and lays out the views.
 *
 * Opening the page with `?zarr=<url>` reads the volume over HTTP; otherwise a button lets the user
 * pick a local `.zarr` folder.
 */

import "#src/style.css";
import type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
import type { ViewOrientation } from "#src/viewer.js";
import { Viewer } from "#src/viewer.js";

declare global {
  interface Window {
    // File System Access API (Chrome and Edge).
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }
}

const app = document.querySelector<HTMLDivElement>("#app")!;

const zarrUrl = new URLSearchParams(window.location.search).get("zarr");
if (zarrUrl !== null) {
  openViewer({ kind: "http", url: zarrUrl });
} else {
  const button = document.createElement("button");
  button.id = "upload";
  button.textContent = "choose .zarr folder";
  button.onclick = async () => {
    const handle = await window.showDirectoryPicker();
    button.remove();
    openViewer({ kind: "directory", handle });
  };
  app.append(button);
}

function openViewer(store: ZarrStoreSpec) {
  const container = document.createElement("div");
  container.id = "neuroglancer-container";
  const loading = document.createElement("div");
  loading.id = "loading";
  loading.textContent = "Loading ...";
  app.append(container, loading);

  const viewer = new Viewer({ container, store });
  viewer.loaded.then(
    () => loading.remove(),
    (error) => {
      console.error("Failed to load the volume:", error);
      loading.textContent = "Failed to load (see console)";
    },
  );

  // Three cross-sections side by side.
  const views = document.createElement("div");
  views.id = "views";
  container.append(views);
  const orientations: ViewOrientation[] = ["yz", "xy", "xz"];
  for (const orientation of orientations) {
    const element = document.createElement("div");
    element.className = "view";
    views.append(element);
    viewer.addView(element, orientation);
  }
}
