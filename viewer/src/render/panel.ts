/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { RenderViewport } from "#src/render/base.js";
import { SliceView } from "#src/render/frontend.js";
import type { ImageRenderLayer } from "#src/render/renderlayer.js";
import type { NavigationState } from "#src/state/navigation_state.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import { initializeWebGL } from "#src/webgl/context.js";

/**
 * The canvas shared by all panels, covering `container`.  After `scheduleRedraw`, `draw` runs on
 * the next animation frame and lets each panel draw into its own region of the canvas.
 */
export class DisplayContext extends RefCounted {
  canvas = document.createElement("canvas");
  gl: GL;
  panels = new Set<SliceViewPanel>();
  // Incremented when a panel is added, or the container or a panel changes size; the canvas size
  // and panel bounds are then recomputed.
  resizeGeneration = 0;
  boundsGeneration = -1;
  // Where the canvas is on the page, as of the last bounds update.
  canvasRect = new DOMRect();
  // Dispatched when a frame starts drawing.
  updateStarted = new NullarySignal();
  private resizeObserver = new ResizeObserver(() => this.handleResize());

  constructor(public container: HTMLElement) {
    super();
    const { canvas } = this;
    container.style.position = "relative";
    canvas.style.position = "absolute";
    canvas.style.top = "0px";
    canvas.style.left = "0px";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.zIndex = "0";
    container.appendChild(canvas);
    this.gl = initializeWebGL(canvas);
    this.resizeObserver.observe(container);
    this.registerDisposer(() => this.resizeObserver.disconnect());
  }

  addPanel(panel: SliceViewPanel) {
    this.panels.add(panel);
    this.resizeObserver.observe(panel.element);
    this.handleResize();
  }

  removePanel(panel: SliceViewPanel) {
    this.panels.delete(panel);
    this.resizeObserver.unobserve(panel.element);
    this.handleResize();
  }

  private handleResize() {
    ++this.resizeGeneration;
    this.scheduleRedraw();
  }

  readonly scheduleRedraw = this.registerCancellable(
    animationFrameDebounce(() => this.draw()),
  );

  ensureBoundsUpdated() {
    const { resizeGeneration } = this;
    if (this.boundsGeneration === resizeGeneration) return;
    const { canvas } = this;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    this.canvasRect = canvas.getBoundingClientRect();
    this.boundsGeneration = resizeGeneration;
  }

  draw() {
    const { gl } = this;
    this.updateStarted.dispatch();
    this.ensureBoundsUpdated();
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const panel of this.panels) {
      if (panel.visibility.value === Number.NEGATIVE_INFINITY) continue;
      panel.ensureBoundsUpdated();
      const { renderViewport } = panel;
      if (renderViewport.width === 0 || renderViewport.height === 0) continue;
      panel.draw();
    }

    // Ensure the alpha buffer is set to 1.
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    gl.colorMask(false, false, false, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(true, true, true, true);
  }
}

export interface SliceViewerState {
  display: DisplayContext;
  chunkManager: ChunkManager;
  // The render layer that draws the volume; `undefined` until the volume has loaded.
  renderLayer: WatchableValueInterface<ImageRenderLayer | undefined>;
}

const tempVec3 = vec3.create();
const tempMat4 = mat4.create();
const tempOffset = new Float32Array(2);

function hasNoModifiers(event: MouseEvent) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

function hasOnlyControl(event: MouseEvent) {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

// How far outside the container a panel still counts as about to be seen (see `visibility`).
const NEAR_SCREEN_MARGIN = "200px";

// Zoom factor for one wheel event: e^(deltaY / 200) when the delta is in pixels.
function getWheelZoomAmount(event: WheelEvent) {
  let multiplier = 0;
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_PIXEL:
      multiplier = 1 / 200.0;
      break;
    case WheelEvent.DOM_DELTA_LINE:
      multiplier = 1 / 10.0;
      break;
    case WheelEvent.DOM_DELTA_PAGE:
      multiplier = 2;
      break;
  }
  return Math.exp(event.deltaY * multiplier);
}

/**
 * One cross-section view.  Its `SliceView` draws into the part of the shared canvas covered by
 * `element`.  Mouse input on `element` becomes navigation:
 *
 *   - left drag: pan
 *   - wheel: move one voxel along the viewing direction
 *   - control+wheel: zoom around the mouse position
 */
export class SliceViewPanel extends RefCounted {
  gl: GL = this.viewer.display.gl;

  // Generation used to check whether the following bounds-related fields are up to date.
  boundsGeneration = -1;

  // Offset of visible portion of panel in canvas pixels from left side of canvas.
  canvasRelativeClippedLeft = 0;

  // Offset of visible portion of panel in canvas pixels from top of canvas.
  canvasRelativeClippedTop = 0;

  renderViewport = new RenderViewport();

  /**
   * How much this panel's chunks are worth loading: `POSITIVE_INFINITY` while the panel is on
   * screen, `0` while it is only near its container (scrolled just out of a board of views, say),
   * and `NEGATIVE_INFINITY` once it is neither, in which case it is not drawn and its chunks are
   * not requested at all (see `render/backend.ts`).  Panels start out visible, so that the first
   * frame is not delayed by waiting for the observers below.
   */
  visibility = new WatchableValue(Number.POSITIVE_INFINITY);
  private onScreen = true;
  private nearScreen = true;

  sliceView: SliceView;

  constructor(
    public element: HTMLElement,
    public navigationState: NavigationState,
    public viewer: SliceViewerState,
  ) {
    super();
    const { display, chunkManager, renderLayer } = viewer;
    display.addPanel(this);
    this.registerDisposer(() => display.removePanel(this));

    const updateVisibility = () => {
      this.visibility.value = this.onScreen
        ? Number.POSITIVE_INFINITY
        : this.nearScreen
          ? 0
          : Number.NEGATIVE_INFINITY;
    };
    const observe = (
      options: IntersectionObserverInit,
      set: (intersecting: boolean) => void,
    ) => {
      const observer = new IntersectionObserver((entries) => {
        set(entries[entries.length - 1].isIntersecting);
        updateVisibility();
      }, options);
      observer.observe(element);
      this.registerDisposer(() => observer.disconnect());
    };
    // Whether the panel is on screen at all, and whether it is at least close to its place in the
    // container.  The second observer measures against the container rather than the window,
    // because a container that clips (a scrolling board of views) hides the panel from the window
    // long before it is far away.
    observe({}, (intersecting) => (this.onScreen = intersecting));
    observe(
      { root: display.container, rootMargin: NEAR_SCREEN_MARGIN },
      (intersecting) => (this.nearScreen = intersecting),
    );

    this.sliceView = this.registerDisposer(
      new SliceView(chunkManager, renderLayer, navigationState, this.visibility),
    );

    this.registerDisposer(
      this.sliceView.viewChanged.add(() => display.scheduleRedraw()),
    );

    const onMouseDown = (event: MouseEvent) => {
      if (event.target !== element || event.button !== 0) return;
      if (!hasNoModifiers(event)) return;
      event.stopPropagation();
      this.startDrag(event);
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent) => {
      if (hasOnlyControl(event)) {
        event.stopPropagation();
        this.zoomByMouse(event, getWheelZoomAmount(event));
        event.preventDefault();
      } else if (event.target === element && hasNoModifiers(event)) {
        event.stopPropagation();
        const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        tempVec3[0] = 0;
        tempVec3[1] = 0;
        tempVec3[2] = delta > 0 ? -1 : 1;
        this.navigationState.translateVoxelsRelative(tempVec3);
        event.preventDefault();
      }
    };

    element.addEventListener("mousedown", onMouseDown);
    element.addEventListener("wheel", onWheel);
    this.registerDisposer(() => {
      element.removeEventListener("mousedown", onMouseDown);
      element.removeEventListener("wheel", onWheel);
    });
  }

  // Pans with every pointer move until the button that started the drag is released.
  private startDrag(initialEvent: MouseEvent) {
    const { document } = initialEvent.view!;
    const { button } = initialEvent;
    let prevClientX = initialEvent.clientX;
    let prevClientY = initialEvent.clientY;
    const onMove = (e: PointerEvent) => {
      const deltaX = e.clientX - prevClientX;
      const deltaY = e.clientY - prevClientY;
      prevClientX = e.clientX;
      prevClientY = e.clientY;
      this.translateByViewportPixels(deltaX, deltaY);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === button) stop();
    };
    const stop = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, false);
      document.removeEventListener("pointercancel", stop, false);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, false);
    document.addEventListener("pointercancel", stop, false);
  }

  translateByViewportPixels(deltaX: number, deltaY: number): void {
    this.navigationState.updateDisplayPosition((pos: vec3) => {
      vec3.set(pos, -deltaX, -deltaY, 0);
      vec3.transformMat4(
        pos,
        pos,
        this.sliceView.projectionParameters.value.invViewMatrix,
      );
    });
  }

  draw() {
    const { sliceView } = this;
    if (!sliceView.valid) {
      return;
    }
    this.setGLClippedViewport();
    sliceView.draw();
  }

  // Limits drawing to the part of the canvas under the panel's element.
  setGLClippedViewport() {
    const {
      gl,
      canvasRelativeClippedTop,
      canvasRelativeClippedLeft,
      renderViewport: { width, height },
    } = this;
    const bottom = canvasRelativeClippedTop + height;
    gl.enable(WebGL2RenderingContext.SCISSOR_TEST);
    const glBottom = this.viewer.display.canvas.height - bottom;
    gl.viewport(canvasRelativeClippedLeft, glBottom, width, height);
    gl.scissor(canvasRelativeClippedLeft, glBottom, width, height);
  }

  ensureBoundsUpdated() {
    const { display } = this.viewer;
    display.ensureBoundsUpdated();
    if (display.boundsGeneration === this.boundsGeneration) return;
    this.boundsGeneration = display.boundsGeneration;

    const clientRect = this.element.getBoundingClientRect();
    const { x, y, width, height } = clientRect;

    this.canvasRelativeClippedTop = y - display.canvasRect.top;
    this.canvasRelativeClippedLeft = x - display.canvasRect.left;

    const viewport = this.renderViewport;
    viewport.width = width - 1;
    viewport.height = height;

    this.sliceView.projectionParameters.setViewport(this.renderViewport);
  }

  // Position on the page, as an offset in viewport pixels from the center of the panel.
  private offsetFromCenter(clientX: number, clientY: number) {
    const { element, renderViewport } = this;
    const bounds = element.getBoundingClientRect();
    tempOffset[0] =
      clientX - (bounds.left + element.clientLeft) - renderViewport.width / 2;
    tempOffset[1] =
      clientY - (bounds.top + element.clientTop) - renderViewport.height / 2;
    return tempOffset;
  }

  /**
   * Returns the point, in the viewer's (z, y, x) coordinates, shown at `clientX`, `clientY` on the
   * page, or `undefined` before the volume has loaded.  Computed from the navigation state rather than
   * the projection parameters, which are updated after a delay.
   */
  pointAt(clientX: number, clientY: number) {
    const { navigationState } = this;
    if (!navigationState.valid) return undefined;
    navigationState.toMat4(tempMat4);
    const [x, y] = this.offsetFromCenter(clientX, clientY);
    const point = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      point[i] = tempMat4[i] * x + tempMat4[4 + i] * y + tempMat4[12 + i];
    }
    return point;
  }

  /**
   * Zooms by the specified factor, maintaining the data position that projects to the mouse
   * position of `event`.
   */
  zoomByMouse(event: MouseEvent, factor: number) {
    const { navigationState } = this;
    if (!navigationState.valid) {
      return;
    }
    const { invViewMatrix } = this.sliceView.projectionParameters.value;
    const [mouseX, mouseY] = this.offsetFromCenter(event.clientX, event.clientY);
    // Desired invariance:
    //
    // invViewMatrixLinear * [mouseX, mouseY, 0]^T + [oldX, oldY, oldZ]^T =
    // invViewMatrixLinear * factor * [mouseX, mouseY, 0]^T + [newX, newY, newZ]^T

    const position = navigationState.position.value;
    for (let i = 0; i < 3; ++i) {
      const f = invViewMatrix[i] * mouseX + invViewMatrix[4 + i] * mouseY;
      position[i] += f * (1 - factor);
    }
    navigationState.position.changed.dispatch();
    navigationState.zoomBy(factor);
  }
}
