/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { RenderViewport } from "#src/render/projection_parameters.js";
import { SliceView } from "#src/sliceview/frontend.js";
import type { ImageRenderLayer } from "#src/sliceview/renderlayer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import { Buffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import { initializeWebGL } from "#src/webgl/context.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";

/**
 * The canvas shared by all panels, covering `container`.  After `scheduleRedraw`, `draw` runs on
 * the next animation frame and lets each panel draw into its own region of the canvas.
 */
export class DisplayContext extends RefCounted {
  canvas = document.createElement("canvas");
  gl: GL;
  panels = new Set<SliceViewPanel>();
  // Incremented when panels are added; the canvas size and panel bounds are then recomputed.
  resizeGeneration = 0;
  boundsGeneration = -1;

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
  }

  addPanel(panel: SliceViewPanel) {
    this.panels.add(panel);
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
    this.boundsGeneration = resizeGeneration;
  }

  draw() {
    const { gl } = this;
    this.ensureBoundsUpdated();
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const panel of this.panels) {
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

/**
 * Draws the texture a `SliceView` rendered into over the current viewport.  Pixels where no chunk
 * was drawn (alpha 0) are shown gray.
 */
class SliceViewTextureRenderer extends RefCounted {
  private shader: ShaderProgram;
  private vertexBuffer: Buffer;

  constructor(public gl: GL) {
    super();
    const builder = new ShaderBuilder(gl);
    builder.addAttribute("vec4", "aVertexPosition");
    builder.addVarying("vec2", "vTexCoord");
    builder.addUniform("sampler2D", "uSampler");
    builder.addInitializer((shader) => {
      gl.uniform1i(shader.uniform("uSampler"), 0);
    });
    builder.addOutputBuffer("vec4", "out_fragColor", null);
    builder.setVertexMain(`
vTexCoord = 0.5 * (aVertexPosition.xy + 1.0);
gl_Position = aVertexPosition;
`);
    builder.setFragmentMain(`
vec4 sampledColor = texture(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {
  sampledColor = vec4(0.5, 0.5, 0.5, 1.0);
}
out_fragColor = sampledColor;
`);
    this.shader = this.registerDisposer(builder.build());
    // Corners of the square covering the viewport, in clip coordinates.
    this.vertexBuffer = this.registerDisposer(
      Buffer.fromData(gl, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1])),
    );
  }

  draw(texture: WebGLTexture | null) {
    const { gl, shader } = this;
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.disable(WebGL2RenderingContext.BLEND);
    const aVertexPosition = shader.attribute("aVertexPosition");
    this.vertexBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/ 2);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    gl.disableVertexAttribArray(aVertexPosition);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(gl: GL) {
    return gl.memoize.get(
      "SliceViewTextureRenderer",
      () => new SliceViewTextureRenderer(gl),
    );
  }
}

const tempVec3 = vec3.create();

function hasNoModifiers(event: MouseEvent) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

function hasOnlyControl(event: MouseEvent) {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

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
 * One cross-section view.  Its `SliceView` renders into a texture, which is drawn into the part of
 * the shared canvas covered by `element`.  Mouse input on `element` becomes navigation:
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

  private textureRenderer = this.registerDisposer(
    SliceViewTextureRenderer.get(this.gl),
  );

  sliceView: any;

  constructor(
    public element: HTMLElement,
    public navigationState: any,
    public viewer: SliceViewerState,
  ) {
    super();
    const { display, chunkManager, renderLayer } = viewer;
    display.addPanel(this);

    this.sliceView = new SliceView(chunkManager, renderLayer, navigationState);

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

  draw(): boolean {
    const { sliceView } = this;
    if (!sliceView.valid) {
      return false;
    }
    sliceView.updateRendering();
    this.setGLClippedViewport();
    this.textureRenderer.draw(sliceView.offscreenFramebuffer.colorTexture);
    return true;
  }

  // Sets the viewport to the clipped viewport.  Any drawing must take
  // `visible{Left,Top,Width,Height}Fraction` into account.
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

    this.canvasRelativeClippedTop = y;
    this.canvasRelativeClippedLeft = x;

    const viewport = this.renderViewport;
    viewport.width = width - 1;
    viewport.height = height;
    viewport.logicalWidth = width - 1;
    viewport.logicalHeight = height;
    viewport.visibleLeftFraction = 0;
    viewport.visibleTopFraction = 0;
    viewport.visibleWidthFraction = 1;
    viewport.visibleHeightFraction = 1;

    this.sliceView.projectionParameters.setViewport(this.renderViewport);
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
    const { element, sliceView } = this;
    const {
      width,
      height,
      invViewMatrix,
      displayDimensionRenderInfo: { displayDimensionIndices, displayRank },
    } = sliceView.projectionParameters.value;
    const bounds = element.getBoundingClientRect();
    const mouseX =
      event.clientX - (bounds.left + element.clientLeft) - width / 2;
    const mouseY =
      event.clientY - (bounds.top + element.clientTop) - height / 2;
    // Desired invariance:
    //
    // invViewMatrixLinear * [mouseX, mouseY, 0]^T + [oldX, oldY, oldZ]^T =
    // invViewMatrixLinear * factor * [mouseX, mouseY, 0]^T + [newX, newY, newZ]^T

    const position = navigationState.position.value;
    for (let i = 0; i < displayRank; ++i) {
      const dim = displayDimensionIndices[i];
      const f = invViewMatrix[i] * mouseX + invViewMatrix[4 + i] * mouseY;
      position[dim] += f * (1 - factor);
    }
    navigationState.position.changed.dispatch();
    navigationState.zoomBy(factor);
  }
}
