/**
 * @file Linked cards.  The cards of one group share a position and a zoom, so moving one moves them
 * all; three linked cards showing the XY, XZ and YZ planes are the three views the page had before
 * it became a board.  A card on its own is in a group of one.
 *
 * A group's shared position and zoom are the viewer's `NavigationGroup`, which any number of views
 * can look through.  It is created from the first volume a member shows, and that volume's bounds
 * are what the position is kept inside; a member showing another volume is drawn at the same voxel
 * coordinates, which only lines up for volumes on the same grid.
 */

import type { Volume } from "viewer";
import { NavigationGroup } from "viewer";
import type { Card } from "./card";

let nextGroupId = 0;
// Spread around the colour wheel by the golden angle, so that neighbouring groups differ.
let nextHue = Math.floor(Math.random() * 360);

export class LinkGroup {
  readonly id = `g${nextGroupId++}`;
  readonly hue = (nextHue = (nextHue + 137) % 360);
  readonly members = new Set<Card>();
  // Undefined until a member has a volume to take the coordinates from.
  navigation: NavigationGroup | undefined;

  // The shared position and zoom, created from the first volume that needs them.
  navigationFor(volume: Volume) {
    if (this.navigation === undefined) {
      this.navigation = new NavigationGroup(volume);
    }
    return this.navigation;
  }

  // Whether this group is worth showing as a link: a group of one is just a card.
  get linked() {
    return this.members.size > 1;
  }

  dispose() {
    this.navigation?.dispose();
    this.navigation = undefined;
  }
}
