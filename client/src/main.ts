/**
 * @file A board of cross-section cards.
 *
 * Every card shows the volume served by the local server (see `server/`), on its own plane and at
 * its own position.  A later round gives each card its own data source and lets cards be linked, so
 * that their coordinates move together.
 */

import type { ViewOrientation } from "viewer";
import { Viewer } from "viewer";
import { listMissingChunks } from "./app/missing_chunks";
import { showPosition } from "./app/position_display";
import { showSourceForm } from "./app/source_form";
import { Board, CARD_WIDTH } from "./board/board";
import { SERVER_API_ENDPOINT } from "./config";
import "./style.css";

const main = document.querySelector<HTMLElement>("main")!;
const element = document.querySelector<HTMLDivElement>("#board")!;
const layer = document.querySelector<HTMLDivElement>("#board-layer")!;
const status = document.querySelector<HTMLElement>("#status")!;

showSourceForm(
  document.querySelector<HTMLElement>("#source")!,
  document.querySelector<HTMLElement>("#source-panel")!,
);

const viewer = new Viewer({ container: element });
const volume = viewer.addVolume(
  { kind: "http", url: `${SERVER_API_ENDPOINT}/api/data/zarr` },
  { onMissingChunk: listMissingChunks(main) },
);
volume.loaded.then(
  () => {
    status.textContent = "";
  },
  (error) => {
    console.error("Failed to load the volume:", error);
    status.textContent = "Could not load the volume. See the browser console.";
    status.classList.add("error");
  },
);

const board = new Board({ viewer, volume, element, layer });
showPosition(board, main);

// The three cross-sections of the old page, side by side.  Each card navigates on its own now.
const GAP = 24;
const START: ViewOrientation[] = ["yz", "xy", "xz"];
START.forEach((orientation, index) => {
  board.addCard({ x: GAP + index * (CARD_WIDTH + GAP), y: GAP }, orientation);
});
