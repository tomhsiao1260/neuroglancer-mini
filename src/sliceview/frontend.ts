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
  VolumeChunkSpecification,
} from "#src/sliceview/base.js";
import {
  ChunkLayout,
  forEachPlaneIntersectingVolumetricChunk,
  SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_RPC_ID,
  SliceViewBase,
  SliceViewProjectionParameters,
} from "#src/sliceview/base.js";
import {
  ChunkFormat,
  FillValueTexture,
  TextureLayout,
} from "#src/sliceview/chunk_format.js";
import { ImageRenderLayer } from "#src/sliceview/renderlayer.js";
import type { TypedArray } from "#src/util/array.js";
import type { DataType } from "#src/util/data_type.js";
import type { Borrowed, Disposer, Owned } from "#src/util/disposable.js";
import { kOneVec, mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import { OffscreenFramebuffer } from "#src/webgl/offscreen.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import { registerSharedObjectOwner } from "#src/worker/worker_rpc.js";

export interface FrontendTransformedSource<
  RLayer extends ImageRenderLayer = ImageRenderLayer,
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> extends TransformedSource<RLayer, Source> {
  chunkTransform: ChunkTransformParameters;
  chunkDisplayTransform: ChunkDisplayTransformParameters;
}

interface FrontendVisibleLayerSources
  extends VisibleLayerSources<
    ImageRenderLayer,
    SliceViewChunkSource,
    FrontendTransformedSource
  > {
  disposers: Disposer[];
}

function serializeTransformedSource(
  tsource: TransformedSource<ImageRenderLayer, SliceViewChunkSource>,
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
  allSources: TransformedSource<ImageRenderLayer, SliceViewChunkSource>[][],
) {
  return allSources.map((scales) => scales.map(serializeTransformedSource));
}

/**
 * Main-thread side of one cross-section view.  Sends its layers' sources and the projection
 * parameters to its worker counterpart (`SliceViewBackend`), which requests the visible chunks,
 * and draws the chunks that have reached the GPU into `offscreenFramebuffer`.
 */
@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends SliceViewBase {
  gl = this.chunkManager.gl;
  viewChanged = new NullarySignal();
  renderingStale = true;
  visibleLayerList = new Array<ImageRenderLayer>();
  visibleLayers: Map<ImageRenderLayer, FrontendVisibleLayerSources>;

  offscreenFramebuffer = this.registerDisposer(
    new OffscreenFramebuffer(this.gl),
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
    renderLayer: ImageRenderLayer,
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
      if (!(renderLayer instanceof ImageRenderLayer)) continue;
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
    const renderContext = {
      sliceView: this,
      projectionParameters,
    };
    // The viewer has a single render layer, so nothing is blended over another layer.
    for (const renderLayer of this.visibleLayerList) {
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);
      gl.depthFunc(WebGL2RenderingContext.LESS);
      gl.clearDepth(1);
      gl.clear(WebGL2RenderingContext.DEPTH_BUFFER_BIT);
      gl.disable(WebGL2RenderingContext.BLEND);
      renderLayer.draw(renderContext);
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

export class VolumeChunkSource extends SliceViewChunkSource<
  VolumeChunkSpecification,
  VolumeChunk
> {
  chunkFormat: ChunkFormat;
  // Layout of the texture of each chunk of this source.
  textureLayout: TextureLayout;
  fillValueTexture: FillValueTexture;

  constructor(
    chunkManager: ChunkManager,
    options: { spec: VolumeChunkSpecification },
  ) {
    super(chunkManager, options);
    const { gl } = chunkManager.chunkQueueManager;
    const { chunkDataSize, dataType } = this.spec;
    let numDims = 0;
    for (const x of chunkDataSize) {
      if (x > 1) ++numDims;
    }
    const textureDims = numDims >= 3 ? 3 : 2;
    this.chunkFormat = this.registerDisposer(
      ChunkFormat.get(gl, dataType, textureDims),
    );
    this.textureLayout = new TextureLayout(gl, chunkDataSize, textureDims);
    this.fillValueTexture = this.registerDisposer(
      FillValueTexture.get(gl, this.chunkFormat, chunkDataSize.length),
    );
  }

  getChunk(x: any): VolumeChunk {
    const chunk = new VolumeChunk(this, x);
    if (chunk.data === null) {
      chunk.texture = this.fillValueTexture.texture;
      chunk.textureLayout = this.fillValueTexture.textureLayout;
    }
    return chunk;
  }
}

/**
 * Main-thread copy of a volume chunk.  Its data is uploaded to a texture while the chunk is in GPU
 * memory; a chunk with no data uses the source's fill value texture instead.
 */
export class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource;
  chunkDataSize: Uint32Array;
  data: TypedArray | null;
  texture: WebGLTexture | null = null;
  textureLayout: TextureLayout | null = null;

  constructor(source: VolumeChunkSource, x: any) {
    super(source, x);
    this.chunkDataSize = x.chunkDataSize || source.spec.chunkDataSize;
    this.data = x.data;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    if (this.data === null) return;
    const { chunkFormat, textureLayout } = this.source;
    const texture = (this.texture = gl.createTexture());
    gl.bindTexture(chunkFormat.textureTarget, texture);
    this.textureLayout = textureLayout;
    chunkFormat.setTextureData(gl, textureLayout, this.data);
    gl.bindTexture(chunkFormat.textureTarget, null);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    if (this.data === null) return;
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureLayout = null;
  }
}

export abstract class MultiscaleVolumeChunkSource extends MultiscaleSliceViewChunkSource<VolumeChunkSource> {
  abstract dataType: DataType;
}
