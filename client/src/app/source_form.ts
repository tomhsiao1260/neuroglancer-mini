/**
 * @file The data the local server reads: a folder on the server's disk, and the remote store it
 * downloads the files missing from that folder from (see `server/src/routes/data.ts`).  One pair for
 * the whole board, until each card gets its own source.
 */

import { SERVER_API_ENDPOINT } from "../config";

const DEFAULT_SCROLL_URL =
  "https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/";

// Fills the form from the server's settings and saves it back, reloading the page with the new data.
export function showSourceForm(button: HTMLElement, panel: HTMLElement) {
  const local = panel.querySelector<HTMLInputElement>("#source-local")!;
  const url = panel.querySelector<HTMLInputElement>("#source-url")!;
  const save = panel.querySelector<HTMLButtonElement>("#source-save")!;
  url.placeholder = DEFAULT_SCROLL_URL;

  button.addEventListener("click", async () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    const response = await fetch(`${SERVER_API_ENDPOINT}/api/settings`);
    const settings = await response.json();
    local.value = settings.zarr_data_path ?? "";
    url.value = settings.scroll_url_path ?? "";
    local.focus();
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const response = await fetch(`${SERVER_API_ENDPOINT}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zarr_data_path: local.value.trim(),
          scroll_url_path: url.value.trim(),
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      // The cards hold the volume that was loaded from the old source.
      window.location.reload();
    } catch (error) {
      save.disabled = false;
      console.error("Failed to save the source:", error);
      alert("Could not save the source. See the browser console for details.");
    }
  });
}
