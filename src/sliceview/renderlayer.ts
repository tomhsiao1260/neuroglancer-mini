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
import { ChunkRenderLayerFrontend } from "#src/chunk_manager/frontend.js";
import type { CoordinateSpace } from "#src/state/coordinate_transform.js";
import type {
  ChunkTransformParameters,
  RenderLayerTransformOrError,
} from "#src/render/render_coordinate_transform.js";
import { RenderLayer } from "#src/render/renderlayer.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type {
  SliceViewProjectionParameters,
  SliceViewSourceOptions,
  TransformedSource,
} from "#src/sliceview/base.js";
import {
  filterVisibleSources,
  SLICEVIEW_RENDERLAYER_RPC_ID,
} from "#src/sliceview/base.js";
import type {
  MultiscaleSliceViewChunkSource,
  SliceView,
  SliceViewChunkSource,
  SliceViewSingleResolutionSource,
} from "#src/sliceview/frontend.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { constantWatchableValue } from "#src/state/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { HistogramSpecifications } from "#src/webgl/empirical_cdf.js";
import type { RpcId } from "#src/worker/worker_rpc.js";

export interface SliceViewRenderLayerOptions {
  /**
   * Specifies the transform from the "model" coordinate space (specified by the multiscale source)
   * to the "render layer" coordinate space.
   */
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  renderScaleTarget?: WatchableValueInterface<number>;

  /**
   * Specifies the position within the "local" coordinate space.
   */
  localPosition: WatchableValueInterface<Float32Array>;

  rpcTransfer?: { [index: string]: number | string | null };
}

export interface VisibleSourceInfo<Source extends SliceViewChunkSource> {
  source: Borrowed<Source>;
  refCount: number;
  chunkTransform: ChunkTransformParameters;
}

export interface SliceViewRenderContext {
  sliceView: SliceView;
  projectionParameters: SliceViewProjectionParameters;
  wireFrame: boolean;
}

export abstract class SliceViewRenderLayer<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
  SourceOptions extends SliceViewSourceOptions = SliceViewSourceOptions,
> extends RenderLayer {
  rpcId: RpcId | null = null;
  rpcTransfer: { [index: string]: number | string | null } = {};

  localPosition: WatchableValueInterface<Float32Array>;
  channelCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  transform: WatchableValueInterface<RenderLayerTransformOrError>;

  renderScaleTarget: WatchableValueInterface<number>;

  /**
   * Currently visible sources for this render layer.
   */
  private visibleSources = new Map<
    Borrowed<Source>,
    VisibleSourceInfo<Source>
  >();

  /**
   * Cached list of sources in `visibleSources`, ordered by voxel size.
   *
   * Truncated to zero length when `visibleSources` changes to indicate that it is invalid.
   */
  private visibleSourcesList_: VisibleSourceInfo<Source>[] = [];

  getSources(
    options: SliceViewSourceOptions,
  ): SliceViewSingleResolutionSource<Source>[][] {
    return this.multiscaleSource.getSources(options as any);
  }

  addSource(
    source: Borrowed<Source>,
    chunkTransform: ChunkTransformParameters,
  ) {
    const { visibleSources } = this;
    const info = visibleSources.get(source);
    if (info !== undefined) {
      ++info.refCount;
      info.chunkTransform = chunkTransform;
    } else {
      visibleSources.set(source, { source, refCount: 1, chunkTransform });
      this.visibleSourcesList_.length = 0;
    }
  }

  removeSource(source: Borrowed<Source>) {
    const { visibleSources } = this;
    const info = visibleSources.get(source)!;
    if (info.refCount !== 1) {
      --info.refCount;
    } else {
      visibleSources.delete(source);
      this.visibleSourcesList_.length = 0;
    }
  }

  get visibleSourcesList() {
    const { visibleSources, visibleSourcesList_ } = this;
    if (visibleSourcesList_.length === 0 && visibleSources.size !== 0) {
      for (const info of visibleSources.values()) {
        visibleSourcesList_.push(info);
      }
      // Sort by volume scaling factor.
      visibleSourcesList_.sort((a, b) => {
        return (
          a.chunkTransform.chunkToLayerTransformDet -
          b.chunkTransform.chunkToLayerTransformDet
        );
      });
    }
    return visibleSourcesList_;
  }

  constructor(
    public chunkManager: ChunkManager,
    public multiscaleSource: MultiscaleSliceViewChunkSource<
      Source,
      SourceOptions
    >,
    options: SliceViewRenderLayerOptions,
  ) {
    super();

    const { renderScaleTarget = constantWatchableValue(1) } = options;
    this.renderScaleTarget = renderScaleTarget;
    this.transform = options.transform;
    this.localPosition = options.localPosition;
    this.rpcTransfer = options.rpcTransfer || {};
    this.dataHistogramSpecifications = this.registerDisposer(
      options.dataHistogramSpecifications ??
        new HistogramSpecifications(
          constantWatchableValue([]),
          constantWatchableValue([]),
          constantWatchableValue([]),
        ),
    );
    this.registerDisposer(
      this.dataHistogramSpecifications.visibility.changed.add(
        this.redrawNeeded.dispatch,
      ),
    );
  }

  RPC_TYPE_ID: string;

  initializeCounterpart() {
    const sharedObject = this.registerDisposer(
      new ChunkRenderLayerFrontend(this.layerChunkProgressInfo),
    );
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = this.RPC_TYPE_ID;
    sharedObject.initializeCounterpart(rpc, {
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget),
      ).rpcId,
      ...this.rpcTransfer,
    });
    this.rpcId = sharedObject.rpcId;
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number): void {
    // Default blend mode for non-blend-mode-aware layers
    if (renderLayerNum > 0) {
      gl.enable(WebGL2RenderingContext.BLEND);
      gl.blendFunc(
        WebGL2RenderingContext.SRC_ALPHA,
        WebGL2RenderingContext.ONE_MINUS_SRC_ALPHA,
      );
    } else {
      gl.disable(WebGL2RenderingContext.BLEND);
    }
  }

  abstract draw(renderContext: SliceViewRenderContext): void;

  filterVisibleSources(
    sliceView: any,
    sources: readonly TransformedSource[],
  ): Iterable<TransformedSource> {
    return filterVisibleSources(sliceView, this, sources);
  }
}

SliceViewRenderLayer.prototype.RPC_TYPE_ID = SLICEVIEW_RENDERLAYER_RPC_ID;
