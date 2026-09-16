/**
 * @file The board: the cards, their layout in board coordinates, and the board's own pan and zoom.
 */

import type { View, ViewOrientation, Viewer, Volume } from "viewer";
import { Card } from "./card";
import { bindGestures } from "./gestures";
import type { BoardTransform } from "./transform";
import { cssTransform, toBoard } from "./transform";

// Size of a new card, in board units.
export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 300;

export interface BoardOptions {
  viewer: Viewer;
  // The volume every card shows, until cards get their own data source.
  volume: Volume;
  // The viewer's container, which the board fills.
  element: HTMLElement;
  // The element inside it that carries the board's transform; the cards are its children.
  layer: HTMLElement;
}

export class Board {
  transform: BoardTransform = { x: 0, y: 0, scale: 1 };
  readonly cards: Card[] = [];
  private appliedScale = 1;
  private nextZIndex = 1;
  private viewChangedListeners: (() => void)[] = [];

  constructor(private options: BoardOptions) {
    this.applyTransform();
    bindGestures(this);
  }

  get viewer() {
    return this.options.viewer;
  }

  get volume() {
    return this.options.volume;
  }

  get element() {
    return this.options.element;
  }

  get layer() {
    return this.options.layer;
  }

  // Adds a card at a board position.  `volume` is the board's own unless another one is given, so
  // that cards can show different volumes once they have their own data source.
  addCard(
    { x, y }: { x: number; y: number },
    orientation: ViewOrientation = "xy",
    volume: Volume = this.volume,
  ) {
    const card = new Card(
      this,
      { x, y, width: CARD_WIDTH, height: CARD_HEIGHT },
      orientation,
      volume,
    );
    this.cards.push(card);
    this.bringToFront(card);
    return card;
  }

  removeCard(card: Card) {
    const index = this.cards.indexOf(card);
    if (index < 0) return;
    this.cards.splice(index, 1);
    card.dispose();
    this.reportViewChanged();
  }

  bringToFront(card: Card) {
    card.element.style.zIndex = String(this.nextZIndex++);
  }

  // The card containing `target`, if any.
  cardAt(target: EventTarget | null) {
    if (!(target instanceof Node)) return undefined;
    return this.cards.find((card) => card.element.contains(target));
  }

  cardOfView(view: View) {
    return this.cards.find((card) => card.view === view);
  }

  // The board point at a position on the page.
  pointAt(clientX: number, clientY: number) {
    const bounds = this.element.getBoundingClientRect();
    return toBoard(this.transform, clientX - bounds.left, clientY - bounds.top);
  }

  // Shows the board at its current pan and zoom.
  applyTransform() {
    this.layer.style.transform = cssTransform(this.transform);
    // Panning needs nothing else: each card's slice is drawn in a canvas inside the card, which the
    // transform moves along with it.  Zooming changes how large the cards are on screen, and so how
    // much of the volume each pixel covers, which the viewer has to measure again.
    if (this.transform.scale !== this.appliedScale) {
      this.appliedScale = this.transform.scale;
      this.viewer.invalidateBounds();
    }
  }

  // Calls `callback` whenever any card's position or zoom changes.
  onViewChanged(callback: () => void) {
    this.viewChangedListeners.push(callback);
  }

  reportViewChanged() {
    for (const callback of this.viewChangedListeners) callback();
  }
}
