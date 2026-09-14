/**
 * @file Keeps the position and zoom in the page URL, as `?x=&y=&z=&zoom=`, so that reloading or
 * sharing the URL shows the same place.  Other URL parameters, such as `zarr`, are left unchanged.
 */

import { debounce } from "es-toolkit";
import type { Viewer } from "#src/viewer.js";

// Delay before the URL is updated after the view stops changing.
const URL_UPDATE_DELAY_MS = 200;

function readNumber(params: URLSearchParams, name: string) {
  const value = params.get(name);
  return value === null || value === "" ? Number.NaN : Number(value);
}

function round(value: number) {
  return String(Math.round(value * 100) / 100);
}

// Once the volume has loaded, moves to the position and zoom in the URL, then keeps the URL updated.
export async function syncPositionWithUrl(viewer: Viewer) {
  try {
    await viewer.loaded;
  } catch {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const x = readNumber(params, "x");
  const y = readNumber(params, "y");
  const z = readNumber(params, "z");
  if ([x, y, z].every(Number.isFinite)) {
    viewer.setPosition({ x, y, z });
  }
  const zoom = readNumber(params, "zoom");
  if (Number.isFinite(zoom) && zoom > 0) {
    viewer.setZoom(zoom);
  }

  const updateUrl = debounce(() => {
    const { position } = viewer;
    if (position === undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.set("x", round(position.x));
    url.searchParams.set("y", round(position.y));
    url.searchParams.set("z", round(position.z));
    url.searchParams.set("zoom", String(Number(viewer.zoom.toPrecision(4))));
    window.history.replaceState(null, "", url);
  }, URL_UPDATE_DELAY_MS);
  viewer.onViewChanged(updateUrl);
  updateUrl();
}
