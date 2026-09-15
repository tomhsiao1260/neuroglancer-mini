/**
 * @file Shows, in the bottom-right corner of the viewer, the voxel under the pointer (yellow) and the
 * voxel at the center of the views (white).
 */

import type { Point, Viewer } from "viewer";

function formatVoxel({ x, y, z }: Point) {
  return `x ${Math.round(x)}, y ${Math.round(y)}, z ${Math.round(z)}`;
}

export function showPosition(viewer: Viewer, parent: HTMLElement) {
  const element = document.createElement("div");
  element.id = "position";
  const pointer = document.createElement("span");
  pointer.className = "pointer";
  const center = document.createElement("span");
  element.append(pointer, center);
  parent.append(element);

  const showCenter = () => {
    const { position } = viewer;
    center.textContent = position === undefined ? "" : formatVoxel(position);
  };
  viewer.onViewChanged(showCenter);
  showCenter();

  viewer.onPointerMove((point) => {
    pointer.textContent = point === undefined ? "" : formatVoxel(point);
  });
}
