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

import { debounce } from 'es-toolkit';
import { ChunkState } from "#src/chunk_manager/base.js";
import type {
  ChunkManager,
  ChunkRequesterState,
} from "#src/chunk_manager/frontend.js";
import { Chunk, ChunkSource } from "#src/chunk_manager/frontend.js";
import type { LayerManager } from "#src/layer/index.js";
import type {
  DisplayDimensionRenderInfo,
  NavigationState,
} from "#src/state/navigation_state.js";
import { updateProjectionParametersFromInverseViewAndProjection } from "#src/render/projection_parameters.js";
import type {
  ChunkDisplayTransformParameters,
  ChunkTransformParameters,
  RenderLayerTransformOrError,
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
  SliceViewSourceOptions,
  TransformedSource,
  VisibleLayerSources,
} from "#src/sliceview/base.js";
import {
  forEachPlaneIntersectingVolumetricChunk,
  SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_REQUEST_CHUNK_RPC_ID,
  SLICEVIEW_RPC_ID,
  SliceViewBase,
  SliceViewProjectionParameters,
} from "#src/sliceview/base.js";
import { ChunkLayout } from "#src/sliceview/chunk_layout.js";
import { SliceViewRenderLayer } from "#src/sliceview/renderlayer.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { uncancelableToken } from "#src/util/cancellation.js";
import type { Borrowed, Disposer, Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec4 } from "#src/util/geom.js";
import { kOneVec, mat4, vec3 } from "#src/util/geom.js";
import { MessageList, MessageSeverity } from "#src/util/message_list.js";
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

export type GenericChunkKey = string;

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
  transformGeneration: number;
  lastSeenGeneration: number;
  disposers: Disposer[];
  messages: MessageList;
}

function serializeTransformedSource(
  tsource: TransformedSource<SliceViewRenderLayer, SliceViewChunkSource>,
) {
  return {
    source: tsource.source.addCounterpartRef(),
    effectiveVoxelSize: tsource.effectiveVoxelSize,
    // layerRank: tsource.layerRank,
    // nonDisplayLowerClipBound: tsource.nonDisplayLowerClipBound,
    // nonDisplayUpperClipBound: tsource.nonDisplayUpperClipBound,
    lowerClipBound: tsource.lowerClipBound,
    upperClipBound: tsource.upperClipBound,
    lowerClipDisplayBound: tsource.lowerClipDisplayBound,
    upperClipDisplayBound: tsource.upperClipDisplayBound,
    chunkDisplayDimensionIndices: tsource.chunkDisplayDimensionIndices,
    lowerChunkDisplayBound: tsource.lowerChunkDisplayBound,
    upperChunkDisplayBound: tsource.upperChunkDisplayBound,
    // fixedLayerToChunkTransform: tsource.fixedLayerToChunkTransform,
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

  constructor(
    public chunkManager: ChunkManager,
    public layerManager: LayerManager,
    public navigationState: Owned<NavigationState>,
  ) {
    super(
      new DerivedProjectionParameters({
        parametersConstructor: SliceViewProjectionParameters,
        navigationState,
        update: (out, navigationState) => {
          // console.log("updating ...");
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
      tsource.renderLayer.localPosition.value,
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
    disposers.push(renderLayer.transform.changed.add(this.updateVisibleLayers));
    disposers.push(
      renderLayer.renderScaleTarget.changed.add(() =>
        this.invalidateVisibleSources(),
      ),
    );
  }

  private updateVisibleLayersNow() {
    if (this.wasDisposed) {
      return false;
    }
    // Used to determine which layers are no longer visible.
    const curUpdateGeneration = Date.now();
    const { visibleLayers, visibleLayerList } = this;
    const { displayDimensionRenderInfo } = this.projectionParameters.value;
    const rpc = this.rpc!;
    const rpcMessage: any = { id: this.rpcId };
    let changed = false;
    visibleLayerList.length = 0;
    for (const renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof SliceViewRenderLayer) {
        visibleLayerList.push(renderLayer);

        const disposers: Disposer[] = [];
        const messages = new MessageList();
        const layerInfo = {
          messages,
          allSources: this.getTransformedSources(renderLayer, messages),
          transformGeneration: renderLayer.transform.changed.count,
          visibleSources: [],
          disposers,
          lastSeenGeneration: curUpdateGeneration,
          displayDimensionRenderInfo,
        };
        disposers.push(renderLayer.messages.addChild(layerInfo.messages));
        visibleLayers.set(renderLayer.addRef(), layerInfo);
        this.bindVisibleRenderLayer(renderLayer, disposers);

        rpcMessage.layerId = renderLayer.rpcId;
        rpcMessage.sources = serializeAllTransformedSources(
          layerInfo.allSources,
        );
        rpc.invoke(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, rpcMessage);
        changed = true;
      }
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
      wireFrame: false,
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

  getTransformedSources(
    layer: SliceViewRenderLayer,
    messages: MessageList,
  ): FrontendTransformedSource[][] {
    const transformedSources = getVolumetricTransformedSources(
      this.projectionParameters.value.displayDimensionRenderInfo,
      layer.transform.value,
      (options) => layer.getSources(options),
      messages,
      layer,
    );
    for (const scales of transformedSources) {
      for (const tsource of scales) {
        layer.addSource(tsource.source, tsource.chunkTransform);
      }
    }
    return transformedSources;
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

  // Requests a chunk by its grid position, and returns the result of `transform(chunk)`, where
  // `transform` is guaranteed to be called while the chunk is present in system memory.
  //
  // The `transform` function is used in place of simply returning the chunk, because it is not
  // possible to guarantee that the chunk remains in system memory by the time the promise resolves.
  async fetchChunk<T>(
    chunkGridPosition: Float32Array,
    transform: (chunk: Chunk) => T,
    cancellationToken: CancellationToken = uncancelableToken,
  ): Promise<T> {
    const key = chunkGridPosition.join();
    const existingChunk = this.chunks.get(key);
    if (
      existingChunk !== undefined &&
      existingChunk.state <= ChunkState.SYSTEM_MEMORY
    ) {
      return transform(existingChunk);
    }
    this.addRef();
    let { chunkRequesters } = this;
    if (chunkRequesters === undefined) {
      chunkRequesters = this.chunkRequesters = new Map();
    }
    let requester: ChunkRequesterState;
    let entry = chunkRequesters!.get(key);
    if (entry === undefined) {
      entry = [];
      chunkRequesters!.set(key, entry);
    }
    const promise = new Promise<T>((resolve) => {
      requester = (chunk) => resolve(transform(chunk));
      entry!.push(requester);
    });
    try {
      await this.rpc!.promiseInvoke(
        SLICEVIEW_REQUEST_CHUNK_RPC_ID,
        { source: this.rpcId, chunkGridPosition },
        cancellationToken,
      );
      return await promise;
    } finally {
      const entryIndex = entry.indexOf(requester!);
      entry.splice(entryIndex, 1);
      if (entry.length === 0) {
        chunkRequesters!.delete(key);
      }
      if (chunkRequesters.size === 0) {
        this.chunkRequesters = undefined;
      }
      this.dispose();
    }
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

  /**
   * Lower clipping bound in voxels within the "chunk" coordinate space.  If not specified, defaults
   * to `chunkSource.spec.lowerVoxelBound`.  Non-integer values are supported.
   *
   * Both lowerClipBound and upperClipBound are applied during rendering but do not affect which
   * chunks/voxels are actually retrieved.  That is determined by lowerVoxelBound and
   * upperVoxelBound of `chunkSource.spec`.
   */
  lowerClipBound?: Float32Array;

  /**
   * Upper clipping bound in voxels within the "chunk" coordinate space.  If not specified, defaults
   * to `chunkSource.spec.upperVoxelBound`.
   */
  upperClipBound?: Float32Array;
}

export abstract class MultiscaleSliceViewChunkSource<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
  SourceOptions extends SliceViewSourceOptions = SliceViewSourceOptions,
> {
  abstract get rank(): number;

  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  Outer array indexes
   * over alternative chunk orientations.  The inner array indexes over scale.
   *
   * Every chunk source must have rank equal to `this.rank`.
   */
  abstract getSources(
    options: SourceOptions,
  ): SliceViewSingleResolutionSource<Source>[][];

  constructor(public chunkManager: Borrowed<ChunkManager>) {}
}

export function getVolumetricTransformedSources(
  displayDimensionRenderInfo: DisplayDimensionRenderInfo,
  transform: RenderLayerTransformOrError,
  getSources: (
    options: SliceViewSourceOptions,
  ) => SliceViewSingleResolutionSource<SliceViewChunkSource>[][],
  messages: MessageList,
  layer: any,
): FrontendTransformedSource[][] {
  messages.clearMessages();
  const returnError = (message: string) => {
    messages.addMessage({
      severity: MessageSeverity.error,
      message,
    });
    return [];
  };
  if (transform.error !== undefined) {
    return returnError(transform.error);
  }
  const layerRank = transform.rank;
  const chunkRank = transform.unpaddedRank;
  const { displayRank } = displayDimensionRenderInfo;
  const layerDisplayDimensionMapping = {
    displayToLayerDimensionIndices: [0, 1, 2],
    layerDisplayDimensionIndices: [0, 1, 2]
  }

  const { displayToLayerDimensionIndices } = layerDisplayDimensionMapping;
  const multiscaleToViewTransform = new Float32Array(displayRank * chunkRank);
  const { modelToRenderLayerTransform } = transform;
  for (let displayDim = 0; displayDim < displayRank; ++displayDim) {
    const layerDim = displayToLayerDimensionIndices[displayDim];
    if (layerDim === -1) continue;
    const factor = 1;
    for (let chunkDim = 0; chunkDim < chunkRank; ++chunkDim) {
      multiscaleToViewTransform[displayRank * chunkDim + displayDim] =
        modelToRenderLayerTransform[(layerRank + 1) * chunkDim + layerDim] *
        factor;
    }
  }
  const allSources = getSources({
    displayRank: displayRank,
    multiscaleToViewTransform: multiscaleToViewTransform,
    modelChannelDimensionIndices: transform.channelToRenderLayerDimensions,
  });
  try {
    const getTransformedSource = (
      singleResolutionSource: SliceViewSingleResolutionSource,
    ): FrontendTransformedSource => {
      const { chunkSource: source } = singleResolutionSource;
      const { spec } = source;
      const {
        lowerClipBound = spec.lowerVoxelBound,
        upperClipBound = spec.upperVoxelBound,
      } = singleResolutionSource;
      const chunkTransform = getChunkTransformParameters(
        transform,
        singleResolutionSource.chunkToMultiscaleTransform,
      );
      const { chunkDataSize } = spec;
      const { channelToChunkDimensionIndices } = chunkTransform;
      const channelRank = channelToChunkDimensionIndices.length;
      const { channelSpaceShape } = transform;
      for (let channelDim = 0; channelDim < channelRank; ++channelDim) {
        const chunkDim = channelToChunkDimensionIndices[channelDim];
        if (chunkDim === -1) continue;
        const size = channelSpaceShape[channelDim];
        if (chunkDataSize[chunkDim] !== size) {
          throw new Error(
            "Channel dimension " +
              transform.layerDimensionNames[
                transform.channelToRenderLayerDimensions[channelDim]
              ] +
              ` has extent ${size} but corresponding chunk dimension has extent ` +
              `${chunkDataSize[chunkDim]}`,
          );
        }
      }
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
        if (chunkDim < chunkRank) {
          chunkDisplaySize[chunkDisplayDimIndex] = spec.chunkDataSize[chunkDim];
          lowerChunkDisplayBound[chunkDisplayDimIndex] =
            spec.lowerChunkBound[chunkDim];
          upperChunkDisplayBound[chunkDisplayDimIndex] =
            spec.upperChunkBound[chunkDim];
          lowerClipDisplayBound[chunkDisplayDimIndex] =
            lowerClipBound[chunkDim];
          upperClipDisplayBound[chunkDisplayDimIndex] =
            upperClipBound[chunkDim];
        }
      }
      chunkDisplaySize.fill(1, numChunkDisplayDims);
      const chunkLayout = new ChunkLayout(
        chunkDisplaySize,
        chunkDisplayTransform.displaySubspaceModelMatrix,
        numChunkDisplayDims,
      );
      // This is an approximation of the voxel size (exact only for permutation/scaling
      // transforms).  It would be better to model the voxel as an ellipsiod and find the
      // lengths of the axes.
      const effectiveVoxelSize = chunkLayout.localSpatialVectorToGlobal(
        vec3.create(),
        /*baseVoxelSize=*/ kOneVec,
      );
      effectiveVoxelSize.fill(1, displayRank);
      return {
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
    return allSources.map((scales) =>
      scales.map((s) => getTransformedSource(s)),
    );
  } catch (e) {
    // Ensure references are released in the case of an exception.
    for (const scales of allSources) {
      for (const { chunkSource: source } of scales) {
        source.dispose();
      }
    }
    const { globalDimensionNames } = displayDimensionRenderInfo;
    const dimensionDesc = Array.from(
      displayDimensionRenderInfo.displayDimensionIndices.filter(
        (i) => i !== -1,
      ),
      (i) => globalDimensionNames[i],
    ).join(",\u00a0");
    const message = `Cannot render (${dimensionDesc}) cross section: ${e.message}`;
    return returnError(message);
  }
}
