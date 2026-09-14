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

import { debounce } from "es-toolkit";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { Chunk, ChunkSource } from "#src/chunk_manager/frontend.js";
import type { ImageUserLayer } from "#src/layer/index.js";
import type { NavigationState } from "#src/state/navigation_state.js";
import { updateProjectionParametersFromInverseViewAndProjection } from "#src/render/projection_parameters.js";
import type {
  ChunkDisplayTransformParameters,
  ChunkTransformParameters,
  RenderLayerTransform,
} from "#src/render/render_coordinate_transform.js";
import {
  getChunkDisplayTransformParameters,
  getChunkTransformParameters,
} from "#src/render/render_coordinate_transform.js";
import {
  DerivedProjectionParameters,
  SharedProjectionParameters,
} from "#src/render/renderlayer.js";
import type {
  SliceViewChunkSource as SliceViewChunkSourceInterface,
  SliceViewChunkSpecification,
  TransformedSource,
  VisibleLayerSources,
} from "#src/sliceview/base.js";
import {
  forEachPlaneIntersectingVolumetricChunk,
  SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_RPC_ID,
  SliceViewBase,
  SliceViewProjectionParameters,
} from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type { Borrowed, Disposer, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec4 } from "#src/util/geom.js";
import { kOneVec, mat4, vec3 } from "#src/util/geom.js";
import { getObjectId } from "#src/util/object_id.js";
import { NullarySignal } from "#src/util/signal.js";
import { withSharedVisibility } from "#src/visibility_priority/frontend.js";
import type { GL } from "#src/webgl/context.js";
import {
  DepthTextureBuffer,
  FramebufferConfiguration,
  makeTextureBuffers,
} from "#src/webgl/offscreen.js";
import type { ShaderModule, ShaderProgram } from "#src/webgl/shader.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import { getSquareCornersBuffer } from "#src/webgl/square_corners_buffer.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import { registerSharedObjectOwner } from "#src/worker/worker_rpc.js";

const Base = withSharedVisibility(SliceViewBase);

export interface FrontendTransformedSource<
  RLayer extends SliceViewRenderLayer = SliceViewRenderLayer,
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> extends TransformedSource<RLayer, Source> {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
}

interface FrontendVisibleLayerSources
  extends VisibleLayerSources<
    SliceViewRenderLayer,
    SliceViewChunkSource,
    FrontendTransformedSource
  > {
  disposers: Disposer[];
}

function serializeTransformedSource(
  tsource: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>,
) {
  return {
    source: tsource.source.addCounterpartRef(),
    effectiveVoxelSize: tsource.effectiveVoxelSize,
    layerRank: tsource.layerRank,
    lowerClipBound: tsource.lowerClipBound,
    upperClipBound: tsource.upperClipBound,
    lowerClipDisplayBound: tsource.lowerClipDisplayBound,
    upperClipDisplayBound: tsource.upperClipDisplayBound,
    chunkDisplayDimensionIndices: tsource.chunkDisplayDimensionIndices,
    lowerChunkDisplayBound: tsource.lowerChunkDisplayBound,
    upperChunkDisplayBound: tsource.upperChunkDisplayBound,
    combinedGlobalLocalToChunkTransform:
      tsource.combinedGlobalLocalToChunkTransform,
    chunkLayout: tsource.chunkLayout.toObject(),
  };
}

export function serializeAllTransformedSources(
  allSources: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>[][],
) {
  return allSources.map((scales) => scales.map(serializeTransformedSource));
}

/**
 * Main-thread side of one cross-section view.  Sends its layers' sources and the projection
 * parameters to its worker counterpart (`SliceViewBackend`), which requests the visible chunks,
 * and draws the chunks that have reached the GPU into `offscreenFramebuffer`.
 */
@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends Base {
  gl = this.chunkManager.gl;
  viewChanged = new NullarySignal();
  renderingStale = true;
  visibleChunksStale = true;
  visibleLayerList = new Array<SliceViewRenderLayer>();
  visibleLayers: Map<SliceViewRenderLayer, FrontendVisibleLayerSources>;

  offscreenFramebuffer = this.registerDisposer(
    new FramebufferConfiguration(this.gl, {
      colorBuffers: makeTextureBuffers(this.gl, 1),
      depthBuffer: new DepthTextureBuffer(this.gl),
    }),
  );

  projectionParameters: Owned<
    DerivedProjectionParameters<SliceViewProjectionParameters>
  >;

  sharedProjectionParameters: Owned<
    SharedProjectionParameters<SliceViewProjectionParameters>
  >;

  flushBackendProjectionParameters() {
    this.sharedProjectionParameters.flush();
  }

  constructor(
    public chunkManager: ChunkManager,
    public layerManager: ImageUserLayer,
    public navigationState: Owned<NavigationState>,
  ) {
    super(
      new DerivedProjectionParameters({
        parametersConstructor: SliceViewProjectionParameters,
        navigationState,
        update: (out, navigationState) => {
          const { invViewMatrix, centerDataPosition } = out;
          navigationState.toMat4(invViewMatrix);
          for (let i = 0; i < 3; ++i) {
            centerDataPosition[i] = invViewMatrix[12 + i];
          }
          const {
            logicalWidth,
            logicalHeight,
            projectionMat,
            viewportNormalInGlobalCoordinates,
          } = out;
          const relativeDepthRange = 10;
          mat4.ortho(
            projectionMat,
            -logicalWidth / 2,
            logicalWidth / 2,
            logicalHeight / 2,
            -logicalHeight / 2,
            -relativeDepthRange,
            relativeDepthRange,
          );
          updateProjectionParametersFromInverseViewAndProjection(out);
          const { viewMatrix } = out;
          for (let i = 0; i < 3; ++i) {
            viewportNormalInGlobalCoordinates[i] = viewMatrix[i * 4 + 2];
          }
        },
      }),
    );
    const rpc = this.chunkManager.rpc!;
    const sharedProjectionParameters = (this.sharedProjectionParameters =
      this.registerDisposer(
        new SharedProjectionParameters(rpc, this.projectionParameters),
      ));
    this.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      projectionParameters: sharedProjectionParameters.rpcId,
    });
    this.registerDisposer(
      layerManager.layersChanged.add(() => {
        this.updateVisibleLayers();
      }),
    );

    this.viewChanged.add(() => {
      this.renderingStale = true;
    });
    this.registerDisposer(
      chunkManager.chunkQueueManager.visibleChunksChanged.add(
        this.viewChanged.dispatch,
      ),
    );
    this.updateVisibleLayers();
  }

  forEachVisibleChunk(
    tsource: FrontendTransformedSource,
    chunkLayout: ChunkLayout,
    callback: (key: string) => void,
  ) {
    forEachPlaneIntersectingVolumetricChunk(
      this.projectionParameters.value,
      tsource,
      chunkLayout,
      () => {
        callback(tsource.curPositionInChunks.join());
      },
    );
  }

  private updateVisibleLayers = this.registerCancellable(
    debounce(() => {
      this.updateVisibleLayersNow();
    }, 0),
  );

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.viewChanged.dispatch();
  }

  private bindVisibleRenderLayer(
    renderLayer: SliceViewRenderLayer,
    disposers: Disposer[],
  ) {
    disposers.push(
      renderLayer.localPosition.changed.add(() =>
        this.invalidateVisibleChunks(),
      ),
    );
    disposers.push(renderLayer.redrawNeeded.add(this.viewChanged.dispatch));
    disposers.push(
      renderLayer.renderScaleTarget.changed.add(() =>
        this.invalidateVisibleSources(),
      ),
    );
  }

  // Registers render layers added since the last update, and sends their sources to the worker.
  private updateVisibleLayersNow() {
    if (this.wasDisposed) {
      return false;
    }
    const { visibleLayers, visibleLayerList } = this;
    const { displayDimensionRenderInfo } = this.projectionParameters.value;
    const rpc = this.rpc!;
    const rpcMessage: any = { id: this.rpcId };
    let changed = false;
    visibleLayerList.length = 0;
    for (const renderLayer of this.layerManager.readyRenderLayers()) {
      if (!(renderLayer instanceof SliceViewRenderLayer)) continue;
      visibleLayerList.push(renderLayer);
      if (visibleLayers.has(renderLayer)) continue;
      const disposers: Disposer[] = [];
      const layerInfo: FrontendVisibleLayerSources = {
        allSources: getVolumetricTransformedSources(
          renderLayer.transform.value,
          renderLayer.getSources(),
          renderLayer,
        ),
        visibleSources: [],
        disposers,
        displayDimensionRenderInfo,
      };
      visibleLayers.set(renderLayer.addRef(), layerInfo);
      this.bindVisibleRenderLayer(renderLayer, disposers);
      rpcMessage.layerId = renderLayer.rpcId;
      rpcMessage.sources = serializeAllTransformedSources(layerInfo.allSources);
      this.flushBackendProjectionParameters();
      rpc.invoke(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, rpcMessage);
      changed = true;
    }
    if (changed) {
      this.visibleSourcesStale = true;
    }
    // Unconditionally call viewChanged, because layers may have been reordered even if the set of
    // sources is the same.
    this.viewChanged.dispatch();
    return changed;
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.viewChanged.dispatch();
  }

  get valid() {
    return this.navigationState.valid;
  }

  updateRendering() {
    const projectionParameters = this.projectionParameters.value;
    const { width, height } = projectionParameters;
    if (!this.renderingStale || !this.valid || width === 0 || height === 0) {
      return;
    }
    this.renderingStale = false;
    this.updateVisibleLayers.flush();
    this.updateVisibleSources();

    const { gl, offscreenFramebuffer } = this;

    offscreenFramebuffer.bind(width, height);
    gl.disable(gl.SCISSOR_TEST);

    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    let renderLayerNum = 0;
    const renderContext = {
      sliceView: this,
      projectionParameters,
    };
    for (const renderLayer of this.visibleLayerList) {
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);
      gl.depthFunc(WebGL2RenderingContext.LESS);
      gl.clearDepth(1);
      gl.clear(WebGL2RenderingContext.DEPTH_BUFFER_BIT);
      renderLayer.setGLBlendMode(gl, renderLayerNum);
      renderLayer.draw(renderContext);
      ++renderLayerNum;
    }
    gl.disable(WebGL2RenderingContext.BLEND);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    offscreenFramebuffer.unbind();
  }
}

export interface SliceViewChunkSourceOptions<
  Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
> {
  spec: Spec;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export abstract class SliceViewChunkSource<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
    ChunkType extends SliceViewChunk = SliceViewChunk,
  >
  extends ChunkSource
  implements SliceViewChunkSourceInterface
{
  chunks: Map<string, ChunkType>;

  OPTIONS: SliceViewChunkSourceOptions<Spec>;

  spec: Spec;

  constructor(
    chunkManager: ChunkManager,
    options: SliceViewChunkSourceOptions<Spec>,
  ) {
    super(chunkManager, options);
    this.spec = options.spec;
  }

  static encodeSpec(spec: SliceViewChunkSpecification) {
    return {
      chunkDataSize: Array.from(spec.chunkDataSize),
      lowerVoxelBound: Array.from(spec.lowerVoxelBound),
      upperVoxelBound: Array.from(spec.upperVoxelBound),
    };
  }

  static encodeOptions(options: SliceViewChunkSourceOptions): any {
    const encoding = ChunkSource.encodeOptions(options);
    encoding.spec = SliceViewChunkSource.encodeSpec(options.spec);
    return encoding;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.spec = this.spec;
    super.initializeCounterpart(rpc, options);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface SliceViewChunkSource {
  // TODO(jbms): Move this declaration to the class definition above and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(x: any): any;
}

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  source: SliceViewChunkSource;

  constructor(source: SliceViewChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x.chunkGridPosition;
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

/**
 * Helper for rendering a SliceView that has been pre-rendered to a texture.
 */
export class SliceViewRenderHelper extends RefCounted {
  private copyVertexPositionsBuffer = getSquareCornersBuffer(this.gl);
  private shader: ShaderProgram;

  private textureCoordinateAdjustment = new Float32Array(4);

  constructor(
    public gl: GL,
    emitter: ShaderModule,
  ) {
    super();
    const builder = new ShaderBuilder(gl);
    builder.addVarying("vec2", "vTexCoord");
    builder.addUniform("sampler2D", "uSampler");
    builder.addInitializer((shader) => {
      gl.uniform1i(shader.uniform("uSampler"), 0);
    });
    builder.addUniform("vec4", "uColorFactor");
    builder.addUniform("vec4", "uBackgroundColor");
    builder.addUniform("mat4", "uProjectionMatrix");
    builder.addUniform("vec4", "uTextureCoordinateAdjustment");
    builder.require(emitter);
    builder.setFragmentMain(`
vec4 sampledColor = texture(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {
  sampledColor = uBackgroundColor;
}
emit(sampledColor * uColorFactor, 0u);
`);
    builder.addAttribute("vec4", "aVertexPosition");
    builder.setVertexMain(`
vTexCoord = uTextureCoordinateAdjustment.xy + 0.5 * (aVertexPosition.xy + 1.0) * uTextureCoordinateAdjustment.zw;
gl_Position = uProjectionMatrix * aVertexPosition;
`);
    this.shader = this.registerDisposer(builder.build());
  }

  draw(
    texture: WebGLTexture | null,
    projectionMatrix: mat4,
    colorFactor: vec4,
    backgroundColor: vec4,
    xStart: number,
    yStart: number,
    xEnd: number,
    yEnd: number,
  ) {
    const { gl, shader, textureCoordinateAdjustment } = this;
    textureCoordinateAdjustment[0] = xStart;
    textureCoordinateAdjustment[1] = yStart;
    textureCoordinateAdjustment[2] = xEnd - xStart;
    textureCoordinateAdjustment[3] = yEnd - yStart;
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.disable(WebGL2RenderingContext.BLEND);
    gl.uniformMatrix4fv(
      shader.uniform("uProjectionMatrix"),
      false,
      projectionMatrix,
    );
    gl.uniform4fv(shader.uniform("uColorFactor"), colorFactor);
    gl.uniform4fv(shader.uniform("uBackgroundColor"), backgroundColor);
    gl.uniform4fv(
      shader.uniform("uTextureCoordinateAdjustment"),
      textureCoordinateAdjustment,
    );

    const aVertexPosition = shader.attribute("aVertexPosition");
    this.copyVertexPositionsBuffer.bindToVertexAttrib(
      aVertexPosition,
      /*components=*/ 2,
    );

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(gl: GL, emitter: ShaderModule) {
    return gl.memoize.get(
      `sliceview/SliceViewRenderHelper:${getObjectId(emitter)}`,
      () => new SliceViewRenderHelper(gl, emitter),
    );
  }
}

export interface SliceViewSingleResolutionSource<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> {
  chunkSource: Source;

  /**
   * (rank + 1)*(rank + 1) homogeneous transformation matrix from the "chunk" coordinate space to
   * the MultiscaleSliceViewChunkSource space.
   */
  chunkToMultiscaleTransform: Float32Array;
}

export abstract class MultiscaleSliceViewChunkSource<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> {
  abstract get rank(): number;

  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  Outer array indexes
   * over alternative chunk orientations.  The inner array indexes over scale.
   *
   * Every chunk source must have rank equal to `this.rank`.
   */
  abstract getSources(): SliceViewSingleResolutionSource<Source>[][];

  constructor(public chunkManager: Borrowed<ChunkManager>) {}
}

/**
 * Computes, for every scale, where its chunk grid lies in the view: the chunk layout (chunk size
 * and chunk-to-view transform), the chunk and voxel bounds, and the effective voxel size used to
 * choose which scales to show.
 */
export function getVolumetricTransformedSources(
  transform: RenderLayerTransform,
  allSources: SliceViewSingleResolutionSource<SliceViewChunkSource>[][],
  layer: any,
): FrontendTransformedSource[][] {
  const chunkRank = transform.unpaddedRank;
  const layerDisplayDimensionMapping = {
    displayToLayerDimensionIndices: [0, 1, 2],
    layerDisplayDimensionIndices: [0, 1, 2],
  };

  const getTransformedSource = (
    singleResolutionSource: SliceViewSingleResolutionSource,
  ): FrontendTransformedSource => {
    const { chunkSource: source } = singleResolutionSource;
    const { spec } = source;
    const lowerClipBound = spec.lowerVoxelBound;
    const upperClipBound = spec.upperVoxelBound;
    const chunkTransform = getChunkTransformParameters(
      transform,
      singleResolutionSource.chunkToMultiscaleTransform,
    );
    const chunkDisplayTransform = getChunkDisplayTransformParameters(
      chunkTransform,
      layerDisplayDimensionMapping,
    );
    // Compute `chunkDisplaySize`, and `{lower,upper}ChunkDisplayBound`.
    const lowerChunkDisplayBound = vec3.create();
    const upperChunkDisplayBound = vec3.create();
    const lowerClipDisplayBound = vec3.create();
    const upperClipDisplayBound = vec3.create();
    // Size of chunk in "display" coordinate space.
    const chunkDisplaySize = vec3.create();
    const { numChunkDisplayDims, chunkDisplayDimensionIndices } =
      chunkDisplayTransform;
    for (
      let chunkDisplayDimIndex = 0;
      chunkDisplayDimIndex < numChunkDisplayDims;
      ++chunkDisplayDimIndex
    ) {
      const chunkDim = chunkDisplayDimensionIndices[chunkDisplayDimIndex];
      chunkDisplaySize[chunkDisplayDimIndex] = spec.chunkDataSize[chunkDim];
      lowerChunkDisplayBound[chunkDisplayDimIndex] =
        spec.lowerChunkBound[chunkDim];
      upperChunkDisplayBound[chunkDisplayDimIndex] =
        spec.upperChunkBound[chunkDim];
      lowerClipDisplayBound[chunkDisplayDimIndex] = lowerClipBound[chunkDim];
      upperClipDisplayBound[chunkDisplayDimIndex] = upperClipBound[chunkDim];
    }
    const chunkLayout = new ChunkLayout(
      chunkDisplaySize,
      chunkDisplayTransform.displaySubspaceModelMatrix,
    );
    // This is an approximation of the voxel size (exact only for permutation/scaling
    // transforms).  It would be better to model the voxel as an ellipsiod and find the
    // lengths of the axes.
    const effectiveVoxelSize = chunkLayout.localSpatialVectorToGlobal(
      vec3.create(),
      /*baseVoxelSize=*/ kOneVec,
    );
    return {
      layerRank: chunkTransform.layerRank,
      lowerClipBound,
      upperClipBound,
      renderLayer: layer,
      source,
      lowerChunkDisplayBound,
      upperChunkDisplayBound,
      lowerClipDisplayBound,
      upperClipDisplayBound,
      effectiveVoxelSize,
      chunkLayout,
      chunkDisplayDimensionIndices,
      curPositionInChunks: new Float32Array(chunkRank),
      combinedGlobalLocalToChunkTransform:
        chunkTransform.combinedGlobalLocalToChunkTransform,
      fixedPositionWithinChunk: new Uint32Array(chunkRank),
      chunkTransform,
      chunkDisplayTransform,
    };
  };
  return allSources.map((scales) => scales.map(getTransformedSource));
}
