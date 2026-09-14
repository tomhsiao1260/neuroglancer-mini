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
import type { RenderLayerTransform } from "#src/render/render_coordinate_transform.js";
import { RenderLayer } from "#src/render/renderlayer.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type {
  SliceViewProjectionParameters,
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
} from "#src/sliceview/frontend.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { constantWatchableValue } from "#src/state/trackable_value.js";
import type { RpcId } from "#src/worker/worker_rpc.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

export interface SliceViewRenderLayerOptions {
  /**
   * Specifies the transform from the "model" coordinate space (specified by the multiscale source)
   * to the "render layer" coordinate space.
   */
  transform: WatchableValueInterface<RenderLayerTransform>;
  renderScaleTarget?: WatchableValueInterface<number>;

  /**
   * Specifies the position within the "local" coordinate space.
   */
  localPosition: WatchableValueInterface<Float32Array>;
}

export interface SliceViewRenderContext {
  sliceView: SliceView;
  projectionParameters: SliceViewProjectionParameters;
}

export abstract class SliceViewRenderLayer<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> extends RenderLayer {
  rpcId: RpcId | null = null;

  localPosition: WatchableValueInterface<Float32Array>;
  transform: WatchableValueInterface<RenderLayerTransform>;

  renderScaleTarget: WatchableValueInterface<number>;

  getSources() {
    return this.multiscaleSource.getSources();
  }

  constructor(
    public chunkManager: ChunkManager,
    public multiscaleSource: MultiscaleSliceViewChunkSource<Source>,
    options: SliceViewRenderLayerOptions,
  ) {
    super();

    const { renderScaleTarget = constantWatchableValue(1) } = options;
    this.renderScaleTarget = renderScaleTarget;
    this.transform = options.transform;
    this.localPosition = options.localPosition;
  }

  RPC_TYPE_ID: string;

  // Creates the worker counterpart (`SliceViewRenderLayerBackend`), sharing the values the worker
  // needs to choose chunks.
  initializeCounterpart() {
    const sharedObject = this.registerDisposer(new SharedObject());
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = this.RPC_TYPE_ID;
    sharedObject.initializeCounterpart(rpc, {
      localPosition: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.localPosition),
      ).rpcId,
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget),
      ).rpcId,
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
