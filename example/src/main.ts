/**
 * @file Example use of the viewer package: shows a zarr volume in three cross-section views.
 *
 * The volume is read from the `.zarr` folder picked with the button (File System Access API), or,
 * when the page is opened with `?zarr=<url>`, over HTTP from `<url>`.
 */

import { Viewer } from "viewer";
import type { ViewOrientation, ZarrStoreSpec } from "viewer";
import "./style.css";

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
  container.id = "container";
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

  // Three cross-sections side by side; any CSS layout works.
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
