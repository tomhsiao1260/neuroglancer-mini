/**
 * @file A board of cross-section cards.
 *
 * The board starts empty: a double click adds a card, and a card shows a form until it is given a
 * data source (a folder on the server, a remote store, or both).  Cards naming the same source show
 * the same volume, so its chunks are downloaded once.  A later round links cards, so that their
 * coordinates move together, and saves the board on the server.
 */

import { Viewer } from "viewer";
import { listMissingChunks } from "./app/missing_chunks";
import { showPosition } from "./app/position_display";
import { createDefaultSourceForm } from "./app/source_form";
import { Board } from "./board/board";
import { VolumeRegistry } from "./board/sources";
import "./style.css";

const main = document.querySelector<HTMLElement>("main")!;
const element = document.querySelector<HTMLDivElement>("#board")!;
const layer = document.querySelector<HTMLDivElement>("#board-layer")!;
const hint = document.querySelector<HTMLElement>("#board-hint")!;

const defaults = createDefaultSourceForm(
  document.querySelector<HTMLElement>("#source")!,
  document.querySelector<HTMLElement>("#source-panel")!,
);

const viewer = new Viewer({ container: element });
const volumes = new VolumeRegistry(viewer, listMissingChunks(main));
const board = new Board({
  viewer,
  volumes,
  sourceDefaults: () => defaults.get(),
  element,
  layer,
});

showPosition(board, main);

// The hint stands in for the cards while the board is empty.
board.onViewChanged(() => {
  hint.hidden = board.cards.length > 0;
});
