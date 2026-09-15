/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ChunkConstructor } from "#src/chunk_manager/backend.js";
import {
  Chunk,
  ChunkSource,
  withChunkManager,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier } from "#src/chunk_manager/base.js";
import type { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type {
  MultiscaleVolumetricDataRenderLayer,
  ProjectionParameters,
  SliceViewChunkSource as SliceViewChunkSourceInterface,
  SliceViewChunkSpecification,
  SliceViewRenderLayer as SliceViewRenderLayerInterface,
  TransformedSource,
  VolumeChunkSpecification,
} from "#src/render/base.js";
import {
  ChunkLayout,
  filterVisibleSources,
  forEachPlaneIntersectingVolumetricChunk,
  PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID,
  PROJECTION_PARAMETERS_RPC_ID,
  SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID,
  SLICEVIEW_RENDERLAYER_RPC_ID,
  SLICEVIEW_RPC_ID,
  SliceViewBase,
} from "#src/render/base.js";
import type { WatchableValueChangeInterface } from "#src/state/trackable_value.js";
import { vec3, vec3Key } from "#src/util/geom.js";
import { Signal } from "#src/util/signal.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

/**
 * Worker copy of a panel's projection parameters, updated by `SharedProjectionParameters` in
 * `frontend.ts`.  `changed` fires after each update.
 */
@registerSharedObject(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParametersBackend<
    T extends ProjectionParameters = ProjectionParameters,
  >
  extends SharedObjectCounterpart
  implements WatchableValueChangeInterface<T>
{
  value: T;
  oldValue: T;
  changed = new Signal<(oldValue: T, newValue: T) => void>();
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.value = options.value;
    this.oldValue = Object.assign({}, this.value);
  }
}

registerRPC(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, function (x) {
  const obj: SharedProjectionParametersBackend = this.get(x.id);
  const { value, oldValue } = obj;
  Object.assign(oldValue, value);
  Object.assign(value, x.value);
  obj.changed.dispatch(oldValue, value);
});

export const BASE_PRIORITY = -1e12;
export const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk
const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

class SliceViewCounterpartBase extends SliceViewBase<
  SliceViewChunkSourceBackend,
  SliceViewRenderLayerBackend
> {
  constructor(rpc: RPC, options: any) {
    super(rpc.get(options.projectionParameters));
    this.initializeSharedObject(rpc, options.id);
  }
}

function disposeTransformedSources(
  allSources: TransformedSource<
    SliceViewRenderLayerBackend,
    SliceViewChunkSourceBackend
  >[][],
) {
  for (const scales of allSources) {
    for (const tsource of scales) {
      tsource.source.dispose();
    }
  }
}

const SliceViewIntermediateBase = withChunkManager(SliceViewCounterpartBase);
@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceViewBackend extends SliceViewIntermediateBase {
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateVisibleChunks();
      }),
    );
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  private handleRenderScaleTargetChanged = () => {
    this.invalidateVisibleSources();
  };

  updateVisibleChunks() {
    const projectionParameters = this.projectionParameters.value;
    const chunkManager = this.chunkManager;
    this.updateVisibleSources();
    const { centerDataPosition } = projectionParameters;
    // Requests, as VISIBLE, every chunk the cross-section plane cuts through.  Finer scales get
    // higher priority, and within a scale chunks closer to the center of the view come first.
    const priorityTier = ChunkPriorityTier.VISIBLE;
    const basePriority = BASE_PRIORITY;

    const localCenter = tempCenter;

    const chunkSize = tempChunkSize;

    for (const { visibleSources } of this.visibleLayers.values()) {
      for (
        let i = 0, numVisibleSources = visibleSources.length;
        i < numVisibleSources;
        ++i
      ) {
        const tsource = visibleSources[i];
        const { chunkLayout } = tsource;
        chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
        vec3.copy(chunkSize, chunkLayout.size);
        const priorityIndex = i;
        const sourceBasePriority =
          basePriority + SCALE_PRIORITY_MULTIPLIER * priorityIndex;
        forEachPlaneIntersectingVolumetricChunk(
          projectionParameters,
          tsource,
          chunkLayout,
          (positionInChunks) => {
            vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
            const priority = -vec3.distance(localCenter, tempChunkPosition);
            const { curPositionInChunks } = tsource;
            const chunk = tsource.source.getChunk(curPositionInChunks);
            chunkManager.requestChunk(
              chunk,
              priorityTier,
              sourceBasePriority + priority,
            );
          },
        );
      }
    }
  }

  removeVisibleLayer(layer: SliceViewRenderLayerBackend) {
    const { visibleLayers } = this;
    const layerInfo = visibleLayers.get(layer)!;
    visibleLayers.delete(layer);
    disposeTransformedSources(layerInfo.allSources);
    layer.renderScaleTarget.changed.remove(this.handleRenderScaleTargetChanged);
    this.invalidateVisibleSources();
  }

  addVisibleLayer(
    layer: SliceViewRenderLayerBackend,
    allSources: TransformedSource<
      SliceViewRenderLayerBackend,
      SliceViewChunkSourceBackend
    >[][],
  ) {
    const { displayDimensionRenderInfo } = this.projectionParameters.value;
    let layerInfo = this.visibleLayers.get(layer);
    if (layerInfo === undefined) {
      layerInfo = {
        allSources,
        visibleSources: [],
        displayDimensionRenderInfo: displayDimensionRenderInfo,
      };
      this.visibleLayers.set(layer, layerInfo);
      layer.renderScaleTarget.changed.add(this.handleRenderScaleTargetChanged);
    } else {
      disposeTransformedSources(layerInfo.allSources);
      layerInfo.allSources = allSources;
      layerInfo.visibleSources.length = 0;
      layerInfo.displayDimensionRenderInfo = displayDimensionRenderInfo;
    }
    this.invalidateVisibleSources();
  }

  disposed() {
    for (const layer of this.visibleLayers.keys()) {
      this.removeVisibleLayer(layer);
    }
    super.disposed();
  }

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }
}

export function deserializeTransformedSources<
  Source extends SliceViewChunkSourceBackend,
  RLayer extends MultiscaleVolumetricDataRenderLayer,
>(rpc: RPC, serializedSources: any[][], layer: any) {
  const sources = serializedSources.map((scales) =>
    scales.map((serializedSource): TransformedSource<RLayer, Source> => {
      const source = rpc.getRef<Source>(serializedSource.source);
      const chunkLayout = serializedSource.chunkLayout;
      const { rank } = source.spec;
      const tsource: TransformedSource<RLayer, Source> = {
        renderLayer: layer,
        source,
        chunkLayout: ChunkLayout.fromObject(chunkLayout),
        lowerClipDisplayBound: serializedSource.lowerClipDisplayBound,
        upperClipDisplayBound: serializedSource.upperClipDisplayBound,
        lowerChunkDisplayBound: serializedSource.lowerChunkDisplayBound,
        upperChunkDisplayBound: serializedSource.upperChunkDisplayBound,
        effectiveVoxelSize: serializedSource.effectiveVoxelSize,
        chunkDisplayDimensionIndices:
          serializedSource.chunkDisplayDimensionIndices,
        curPositionInChunks: new Float32Array(rank),
        fixedPositionWithinChunk: new Uint32Array(rank),
      };
      return tsource;
    }),
  );
  return sources;
}
registerRPC(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, function (x) {
  const obj = this.get(x.id);
  const layer = <SliceViewRenderLayerBackend>this.get(x.layerId);
  const sources = deserializeTransformedSources<
    SliceViewChunkSourceBackend,
    SliceViewRenderLayerBackend
  >(this, x.sources, layer);
  obj.addVisibleLayer(layer, sources);
});
registerRPC(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, function (x) {
  const obj = this.get(x.id);
  const layer = <SliceViewRenderLayerBackend>this.get(x.layerId);
  obj.removeVisibleLayer(layer);
});

export class SliceViewChunk extends Chunk {
  chunkGridPosition: Float32Array;
  source: SliceViewChunkSourceBackend | null = null;

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg.chunkGridPosition = this.chunkGridPosition;
  }

  downloadSucceeded() {
    super.downloadSucceeded();
  }

  freeSystemMemory() {}

  toString() {
    return this.source!.toString() + ":" + vec3Key(this.chunkGridPosition);
  }
}

export interface SliceViewChunkSourceBackend<
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
  ChunkType extends SliceViewChunk = SliceViewChunk,
> {
  // TODO(jbms): Move this declaration to the class definition below and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(chunkGridPosition: vec3): ChunkType;

  chunkConstructor: ChunkConstructor<SliceViewChunk>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SliceViewChunkSourceBackend<
    Spec extends SliceViewChunkSpecification = SliceViewChunkSpecification,
    ChunkType extends SliceViewChunk = SliceViewChunk,
  >
  extends ChunkSource
  implements SliceViewChunkSourceInterface
{
  spec: Spec;
  chunks: Map<string, ChunkType>;
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
  }

  getChunk(chunkGridPosition: Float32Array) {
    const key = chunkGridPosition.join();
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(this.chunkConstructor) as ChunkType;
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

/**
 * Worker-side volume chunk.  `download` fills `data`; the data is transferred to the main thread
 * (and dropped here) when the chunk is serialized for an upload to the GPU.
 */
export class VolumeChunk extends SliceViewChunk {
  source: VolumeChunkSource | null = null;
  data: ArrayBufferView | null;
  chunkDataSize: Uint32Array | null;

  initializeVolumeChunk(key: string, chunkGridPosition: vec3) {
    super.initializeVolumeChunk(key, chunkGridPosition);
    this.chunkDataSize = null;
    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    const chunkDataSize = this.chunkDataSize;
    if (chunkDataSize !== this.source!.spec.chunkDataSize) {
      msg.chunkDataSize = chunkDataSize;
    }
    const data = (msg.data = this.data);
    if (data !== null) {
      transfers.push(data!.buffer);
    }
    this.data = null;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data?.byteLength ?? 0;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.data = null;
  }
}

export class VolumeChunkSource extends SliceViewChunkSourceBackend {
  spec: VolumeChunkSpecification;
}
VolumeChunkSource.prototype.chunkConstructor = VolumeChunk;

@registerSharedObject(SLICEVIEW_RENDERLAYER_RPC_ID)
export class SliceViewRenderLayerBackend
  extends SharedObjectCounterpart
  implements SliceViewRenderLayerInterface
{
  rpcId: number;
  renderScaleTarget: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
  }

  filterVisibleSources(
    sliceView: any,
    sources: readonly TransformedSource[],
  ): Iterable<TransformedSource> {
    return filterVisibleSources(sliceView, this, sources);
  }
}
