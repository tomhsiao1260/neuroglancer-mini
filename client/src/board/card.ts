/**
 * @file One card: a frame in board coordinates showing a cross-section of the source it names.  A
 * card with no source shows a form instead (see `source_panel.ts`), and each card has its own
 * navigation group, so it steps through slices on its own; a later round links cards so that their
 * coordinates move together.
 */

import type { View, ViewOrientation, Volume } from "viewer";
import { NavigationGroup } from "viewer";
import type { Board } from "./board";
import { createSourcePanel } from "./source_panel";
import type { Source } from "./sources";

export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_CARD_SIZE = 140;

const ORIENTATIONS: ViewOrientation[] = ["xy", "xz", "yz"];

export class Card {
  readonly element = document.createElement("div");
  // The view's element.  The viewer puts its canvas inside it, so it must have no border or padding.
  readonly slice = document.createElement("div");
  // Shows the source form, or how the volume is doing, on top of the slice.
  private overlay = document.createElement("div");
  private orientationSelect = document.createElement("select");
  source: Source | undefined;
  navigation: NavigationGroup | undefined;
  view: View | undefined;

  constructor(
    private board: Board,
    public rect: CardRect,
    private orientation: ViewOrientation,
  ) {
    const { element, slice, overlay, orientationSelect } = this;
    element.className = "card";
    slice.className = "card-slice";
    overlay.className = "card-overlay";

    const header = document.createElement("div");
    header.className = "card-header";
    for (const value of ORIENTATIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.toUpperCase();
      orientationSelect.append(option);
    }
    orientationSelect.value = orientation;
    orientationSelect.className = "card-orientation";
    orientationSelect.title = "The plane this card shows";
    orientationSelect.addEventListener("change", () =>
      this.setOrientation(orientationSelect.value as ViewOrientation),
    );
    const name = document.createElement("span");
    name.className = "card-name";
    const close = document.createElement("button");
    close.className = "card-close";
    close.textContent = "✕";
    close.title = "Remove this card";
    close.addEventListener("click", () => board.removeCard(this));
    header.append(orientationSelect, name, close);
    this.name = name;

    const resize = document.createElement("div");
    resize.className = "card-resize";
    resize.title = "Resize";

    element.append(header, slice, overlay, resize);
    board.layer.append(element);
    this.applyRect();
    this.showForm();
  }

  private name: HTMLElement;

  // Shows the source `source` holds, loading its volume if no other card has.
  setSource(source: Source) {
    this.source = source;
    this.name.textContent = this.board.sourceName(source);
    this.name.title = [source.local, source.http].filter((x) => x !== "").join("\n");
    this.showView(this.board.volumes.get(source.id));
  }

  setOrientation(orientation: ViewOrientation) {
    if (orientation === this.orientation) return;
    this.orientation = orientation;
    this.orientationSelect.value = orientation;
    // A view shows one plane for its whole life, but adding it again costs no downloads.
    const { source } = this;
    if (source !== undefined) this.showView(this.board.volumes.get(source.id));
  }

  setRect(rect: CardRect) {
    this.rect = rect;
    this.applyRect();
    // Nothing else to do: the slice is drawn in a canvas inside the card, so it moves with it, and
    // resizing the card resizes that element, which the viewer is already watching.
  }

  moveBy(deltaX: number, deltaY: number) {
    const { x, y, width, height } = this.rect;
    this.setRect({ x: x + deltaX, y: y + deltaY, width, height });
  }

  resizeBy(deltaX: number, deltaY: number) {
    const { x, y, width, height } = this.rect;
    this.setRect({
      x,
      y,
      width: Math.max(MIN_CARD_SIZE, width + deltaX),
      height: Math.max(MIN_CARD_SIZE, height + deltaY),
    });
  }

  dispose() {
    this.disposeView();
    this.element.remove();
  }

  private showForm() {
    this.setOverlay(
      createSourcePanel({
        defaults: this.board.sourceDefaults(),
        onChosen: (source) => this.setSource(source),
      }),
    );
  }

  private showView(volume: Volume) {
    this.disposeView();
    this.navigation = new NavigationGroup(volume);
    this.navigation.onViewChanged(() => this.board.reportViewChanged());
    this.view = this.board.viewer.addView(this.slice, {
      volume,
      orientation: this.orientation,
      navigation: this.navigation,
    });
    // The board owns the mouse button: a drag moves the card, and with Alt it pans the slice.  The
    // wheel stays with the view, which steps through slices and zooms with Control.
    this.view.handleInput = (event) => event.type === "wheel";

    this.setOverlay(this.message("Loading…"));
    const { view } = this;
    volume.loaded.then(
      () => {
        // The card may have been removed, or given another source, while it loaded.
        if (this.view !== view) return;
        this.setOverlay(undefined);
      },
      (error) => {
        if (this.view !== view) return;
        console.error("Failed to load the volume:", error);
        const message = this.message(
          "Could not load this source. See the browser console for details.",
        );
        const retry = document.createElement("button");
        retry.textContent = "Change the source";
        retry.addEventListener("click", () => {
          this.disposeView();
          this.source = undefined;
          this.name.textContent = "";
          this.showForm();
        });
        message.append(retry);
        this.setOverlay(message);
      },
    );
  }

  private disposeView() {
    this.view?.dispose();
    this.navigation?.dispose();
    this.view = undefined;
    this.navigation = undefined;
  }

  private message(text: string) {
    const element = document.createElement("div");
    element.className = "card-message";
    element.append(document.createTextNode(text));
    return element;
  }

  private setOverlay(content: HTMLElement | undefined) {
    this.overlay.replaceChildren(...(content === undefined ? [] : [content]));
    this.overlay.hidden = content === undefined;
  }

  private applyRect() {
    const { style } = this.element;
    const { x, y, width, height } = this.rect;
    style.left = `${x}px`;
    style.top = `${y}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
  }
}
