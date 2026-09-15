/**
 * @file The app.  The form in `index.html` sets the local `.zarr` folder that the server in `server/`
 * serves and the remote store it downloads missing files from.  The volume is then shown in three
 * views, together with the features in `app/`.
 */

import { Viewer } from "viewer";
import type { ViewOrientation } from "viewer";
import { listMissingChunks } from "./app/missing_chunks";
import { showPosition } from "./app/position_display";
import { syncPositionWithUrl } from "./app/url_position";
import { SERVER_API_ENDPOINT } from "./config";

// Remote store suggested before any settings have been saved.
const DEFAULT_SCROLL_URL =
  "https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/";

const VIEWS: { orientation: ViewOrientation; label: string }[] = [
  { orientation: "yz", label: "YZ View" },
  { orientation: "xy", label: "XY View" },
  { orientation: "xz", label: "XZ View" },
];

const zarrPathInput = document.querySelector<HTMLInputElement>("#zarr-path-input")!;
const scrollUrlInput = document.querySelector<HTMLInputElement>("#scroll-url-input")!;
const confirmButton = document.querySelector<HTMLButtonElement>("#upload")!;

fillSettingsForm().catch((error) =>
  console.error("Could not read the settings from the server:", error),
);

confirmButton.onclick = async () => {
  try {
    await saveSettings();
  } catch (error) {
    console.error(error);
    alert(`Could not save the settings: ${(error as Error).message}`);
    return;
  }
  openViewer();
};

async function fillSettingsForm() {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/settings`);
  const settings = await response.json();
  zarrPathInput.value = settings.zarr_data_path;
  scrollUrlInput.value = settings.zarr_data_path
    ? settings.scroll_url_path
    : DEFAULT_SCROLL_URL;
}

async function saveSettings() {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      zarr_data_path: zarrPathInput.value,
      scroll_url_path: scrollUrlInput.value,
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}

function openViewer() {
  document.querySelector("#upload-container")!.classList.add("hidden");
  document.querySelector("main")!.classList.remove("hidden");
  const loading = document.querySelector<HTMLDivElement>("#loading")!;
  loading.classList.remove("hidden");
  const container = document.querySelector<HTMLDivElement>("#neuroglancer-container")!;

  const viewer = new Viewer({
    container,
    store: { kind: "http", url: `${SERVER_API_ENDPOINT}/api/data/zarr` },
    onMissingChunk: listMissingChunks(container),
  });
  viewer.loaded.then(
    () => loading.classList.add("hidden"),
    (error) => {
      console.error("Failed to load the volume:", error);
      loading.querySelector(".animate-spin")?.remove();
      loading.querySelector("#loading-message")!.textContent =
        "Failed to load (see console)";
    },
  );

  // Three cross-sections side by side; any CSS layout works.
  const views = document.createElement("div");
  views.id = "views";
  container.append(views);
  for (const { orientation, label } of VIEWS) {
    const element = document.createElement("div");
    element.className = "view";
    element.dataset.label = label;
    views.append(element);
    viewer.addView(element, orientation);
  }

  showPosition(viewer, container);
  syncPositionWithUrl(viewer);
}
