/**
 * @file Example use of the viewer package: shows a zarr volume in three cross-section views.
 *
 * When the page is opened with `?zarr=<url>`, the volume is read over HTTP from `<url>`. Otherwise
 * the start screen in `index.html` lets the user pick a local `.zarr` folder (File System Access
 * API).
 */

import { Viewer } from "viewer";
import type { ViewOrientation, ZarrStoreSpec } from "viewer";
import "./style.css";

declare global {
  interface Window {
    // File System Access API (Chrome and Edge only).
    showDirectoryPicker?(): Promise<FileSystemDirectoryHandle>;
  }
}

const app = document.querySelector<HTMLDivElement>("#app")!;
const start = document.querySelector<HTMLElement>("#start")!;
const status = document.querySelector<HTMLElement>("#status")!;
const hint = document.querySelector<HTMLElement>("#hint")!;

let zarrUrl = new URLSearchParams(window.location.search).get("zarr");
// For testing: uncomment to open Scroll 1 from the Vesuvius Challenge without choosing a folder.
// zarrUrl = "https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr";

if (zarrUrl) {
  openViewer({ kind: "http", url: zarrUrl });
} else {
  showStartScreen();
}

function showStartScreen() {
  start.hidden = false;
  const button = document.querySelector<HTMLButtonElement>("#open-folder")!;
  if (!window.showDirectoryPicker) {
    button.disabled = true;
    document.querySelector<HTMLElement>("#folder-note")!.hidden = false;
    return;
  }
  button.onclick = async () => {
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker!();
    } catch {
      return; // The picker was closed without choosing a folder.
    }
    openViewer({ kind: "directory", handle });
  };
}

function openViewer(store: ZarrStoreSpec) {
  start.remove();
  status.hidden = false;
  const container = document.createElement("div");
  container.id = "container";
  app.append(container);

  const viewer = new Viewer({ container, store });
  viewer.loaded.then(
    () => {
      status.remove();
      hint.hidden = false;
    },
    (error) => {
      console.error("Failed to load the volume:", error);
      status.classList.add("error");
      status.textContent =
        "Could not load the volume. See the browser console for details.";
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
