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

// While a card waits to be linked, the header says what to do next.
const linkHint = document.querySelector<HTMLElement>("#link-hint")!;
board.onLinkingChanged((linking) => {
  linkHint.hidden = !linking;
});

// The three cross-sections this page had before it became a board, as one linked set.
document
  .querySelector<HTMLButtonElement>("#add-linked")!
  .addEventListener("click", () => {
    const { x, y } = board.pointAt(
      element.getBoundingClientRect().left + 40,
      element.getBoundingClientRect().top + 40,
    );
    board.addLinkedCards({ x: Math.round(x), y: Math.round(y) });
  });

// The hint stands in for the cards while the board is empty.
board.onViewChanged(() => {
  hint.hidden = board.cards.length > 0;
});
