/**
 * @file One card: a frame in board coordinates with a cross-section view inside it.  Each card has
 * its own navigation group, so it steps through slices on its own; a later round links cards so that
 * their coordinates move together.
 */

import type { View, ViewOrientation, Volume } from "viewer";
import { NavigationGroup } from "viewer";
import type { Board } from "./board";

export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_CARD_SIZE = 120;

export class Card {
  readonly element = document.createElement("div");
  // The view's element.  The viewer puts its canvas inside it, so it must have no border or padding.
  readonly slice = document.createElement("div");
  readonly navigation: NavigationGroup;
  readonly view: View;

  constructor(
    board: Board,
    public rect: CardRect,
    readonly orientation: ViewOrientation,
    readonly volume: Volume,
  ) {
    const { element, slice } = this;
    element.className = "card";
    slice.className = "card-slice";

    const header = document.createElement("div");
    header.className = "card-header";
    const title = document.createElement("span");
    title.textContent = orientation.toUpperCase();
    const close = document.createElement("button");
    close.className = "card-close";
    close.textContent = "✕";
    close.title = "Remove this card";
    close.addEventListener("click", () => board.removeCard(this));
    header.append(title, close);

    const resize = document.createElement("div");
    resize.className = "card-resize";
    resize.title = "Resize";

    element.append(header, slice, resize);
    board.layer.append(element);
    this.applyRect();

    this.navigation = new NavigationGroup(volume);
    this.navigation.onViewChanged(() => board.reportViewChanged());
    this.view = board.viewer.addView(slice, {
      volume,
      orientation,
      navigation: this.navigation,
    });
    // The board owns the mouse button: a drag moves the card, and with Alt it pans the slice.  The
    // wheel stays with the view, which steps through slices and zooms with Control.
    this.view.handleInput = (event) => event.type === "wheel";
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
    this.view.dispose();
    this.navigation.dispose();
    this.element.remove();
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
