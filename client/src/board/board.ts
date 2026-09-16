/**
 * @file The board: the cards, their layout in board coordinates, and the board's own pan and zoom.
 */

import type { View, ViewOrientation } from "viewer";
import type { Viewer } from "viewer";
import { Card } from "./card";
import { bindGestures } from "./gestures";
import { LinkGroup } from "./links";
import type { Source, VolumeRegistry } from "./sources";
import { sourceLabel } from "./sources";
import type { BoardTransform } from "./transform";
import { cssTransform, toBoard } from "./transform";

// Size of a new card, in board units.
export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 300;

export interface BoardOptions {
  viewer: Viewer;
  // The volumes of the sources the cards name.
  volumes: VolumeRegistry;
  // What a new card's source form starts with.
  sourceDefaults: () => { local: string; http: string };
  // The viewer's container, which the board fills.
  element: HTMLElement;
  // The element inside it that carries the board's transform; the cards are its children.
  layer: HTMLElement;
}

export class Board {
  transform: BoardTransform = { x: 0, y: 0, scale: 1 };
  readonly cards: Card[] = [];
  // The card waiting to be linked to the next one clicked, if the user is linking.
  linkFrom: Card | undefined;
  private appliedScale = 1;
  private nextZIndex = 1;
  private viewChangedListeners: (() => void)[] = [];
  private linkingListeners: ((linking: boolean) => void)[] = [];

  constructor(private options: BoardOptions) {
    this.applyTransform();
    bindGestures(this);
  }

  get viewer() {
    return this.options.viewer;
  }

  get volumes() {
    return this.options.volumes;
  }

  get element() {
    return this.options.element;
  }

  get layer() {
    return this.options.layer;
  }

  sourceDefaults() {
    return this.options.sourceDefaults();
  }

  sourceName(source: Source) {
    return sourceLabel(source);
  }

  // Adds a card at a board position.  It shows nothing until it is given a source, and moves on its
  // own unless it is given a group to share a position and zoom with.
  addCard(
    { x, y }: { x: number; y: number },
    orientation: ViewOrientation = "xy",
    group = new LinkGroup(),
  ) {
    const card = new Card(
      this,
      { x, y, width: CARD_WIDTH, height: CARD_HEIGHT },
      orientation,
      group,
    );
    this.cards.push(card);
    this.bringToFront(card);
    this.showLinks();
    this.reportViewChanged();
    return card;
  }

  /**
   * Adds three linked cards side by side, showing the XY, XZ and YZ planes: the three views this
   * page had before it became a board.  Giving one of them a source gives it to all three.
   */
  addLinkedCards({ x, y }: { x: number; y: number }) {
    const group = new LinkGroup();
    const gap = 16;
    return (["yz", "xy", "xz"] as ViewOrientation[]).map((orientation, index) =>
      this.addCard(
        { x: x + index * (CARD_WIDTH + gap), y },
        orientation,
        group,
      ),
    );
  }

  // Starts linking `card`: the next card clicked joins it.
  startLinking(card: Card) {
    this.linkFrom = card;
    this.element.classList.add("linking");
    card.element.classList.add("link-from");
    this.showLinks();
    this.reportLinkingChanged();
  }

  stopLinking() {
    if (this.linkFrom === undefined) return;
    this.linkFrom.element.classList.remove("link-from");
    this.linkFrom = undefined;
    this.element.classList.remove("linking");
    this.showLinks();
    this.reportLinkingChanged();
  }

  // Calls `callback` when the board starts or stops waiting for a card to link to.
  onLinkingChanged(callback: (linking: boolean) => void) {
    this.linkingListeners.push(callback);
  }

  private reportLinkingChanged() {
    for (const callback of this.linkingListeners) {
      callback(this.linkFrom !== undefined);
    }
  }

  /**
   * Puts both cards, and everything already linked to either of them, in one group.  They then show
   * the same place: the larger group's position and zoom win, so the smaller set jumps to it.
   */
  linkCards(first: Card, second: Card) {
    this.stopLinking();
    if (first === second || first.group === second.group) return;
    const [target, leaving] =
      first.group.members.size >= second.group.members.size
        ? [first.group, second.group]
        : [second.group, first.group];
    for (const card of [...leaving.members]) card.setGroup(target);
    leaving.dispose();
    this.showLinks();
  }

  // Takes `card` out of its group, leaving it where it is.
  unlinkCard(card: Card) {
    const previous = card.group.navigation;
    const position = previous?.position;
    const zoom = previous?.zoom;
    card.setGroup(new LinkGroup());
    const navigation = card.group.navigation;
    if (navigation !== undefined) {
      if (position !== undefined) navigation.setPosition(position);
      if (zoom !== undefined) navigation.setZoom(zoom);
    }
    this.showLinks();
  }

  // Shows every card's link state, which changes for a whole group at a time.
  showLinks() {
    for (const card of this.cards) card.showLink();
  }

  removeCard(card: Card) {
    const index = this.cards.indexOf(card);
    if (index < 0) return;
    if (this.linkFrom === card) this.stopLinking();
    this.cards.splice(index, 1);
    const { group } = card;
    card.dispose();
    // The last card of a group takes its shared position and zoom with it.
    if (group.members.size === 0) group.dispose();
    this.showLinks();
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

  // Calls `callback` whenever a card is added or removed, or any card's position or zoom changes.
  onViewChanged(callback: () => void) {
    this.viewChangedListeners.push(callback);
  }

  reportViewChanged() {
    for (const callback of this.viewChangedListeners) callback();
  }
}
