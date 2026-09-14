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

/**
 * @file Main-thread side of chunk management.
 *
 * The worker decides which chunks to load and where they should live (see
 * `chunk_manager/backend.ts`).  It sends each change as a `Chunk.update` message, which is queued
 * here and applied in time slices: new chunks arrive with their data, are uploaded to the GPU,
 * freed from the GPU, or deleted once expired.
 */

import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import {
  CHUNK_MANAGER_RPC_ID,
  CHUNK_QUEUE_MANAGER_RPC_ID,
  ChunkState,
} from "#src/chunk_manager/base.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { stableStringify } from "#src/util/json.js";
import { StringMemoize } from "#src/util/memoize.js";
import { getObjectId } from "#src/util/object_id.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker/worker_rpc.js";

// Maximum time spent applying queued chunk updates before yielding to the next frame.
const CHUNK_UPDATE_TIME_BUDGET_MS = 30;
const CHUNK_UPDATE_DELAY_MS = 30;

export class Chunk {
  state = ChunkState.SYSTEM_MEMORY;
  constructor(public source: ChunkSource) {}

  get gl() {
    return this.source.gl;
  }

  copyToGPU(_gl: GL) {
    this.state = ChunkState.GPU_MEMORY;
  }

  freeGPUMemory(_gl: GL) {
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

/**
 * Limit on the number of chunks (`itemLimit`) and total bytes (`sizeLimit`) that may be in one
 * place (GPU memory, system memory, or downloading) at a time.
 */
export class CapacitySpecification {
  sizeLimit: WatchableValue<number>;
  itemLimit: WatchableValue<number>;
  constructor({
    defaultItemLimit = Number.POSITIVE_INFINITY,
    defaultSizeLimit = Number.POSITIVE_INFINITY,
  } = {}) {
    this.sizeLimit = new WatchableValue<number>(defaultSizeLimit);
    this.itemLimit = new WatchableValue<number>(defaultItemLimit);
  }
}

@registerSharedObjectOwner(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObject {
  visibleChunksChanged = new NullarySignal();
  // Singly linked list (through `nextUpdate`) of `Chunk.update` messages not yet applied.
  pendingChunkUpdates: any = null;
  pendingChunkUpdatesTail: any = null;

  enablePrefetch = { value: true, changed: new NullarySignal() };

  constructor(
    rpc: RPC,
    public gl: GL,
    capacities: {
      gpuMemory: CapacitySpecification;
      systemMemory: CapacitySpecification;
      download: CapacitySpecification;
    },
  ) {
    super();

    const makeCapacityCounterparts = (capacity: CapacitySpecification) => {
      return {
        itemLimit: this.registerDisposer(
          SharedWatchableValue.makeFromExisting(rpc, capacity.itemLimit),
        ).rpcId,
        sizeLimit: this.registerDisposer(
          SharedWatchableValue.makeFromExisting(rpc, capacity.sizeLimit),
        ).rpcId,
      };
    };

    this.initializeCounterpart(rpc, {
      gpuMemoryCapacity: makeCapacityCounterparts(capacities.gpuMemory),
      systemMemoryCapacity: makeCapacityCounterparts(capacities.systemMemory),
      downloadCapacity: makeCapacityCounterparts(capacities.download),
      enablePrefetch: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.enablePrefetch),
      ).rpcId,
    });
  }

  scheduleChunkUpdate() {
    setTimeout(() => this.processPendingChunkUpdates(), 0);
  }

  processPendingChunkUpdates() {
    const deadline = Date.now() + CHUNK_UPDATE_TIME_BUDGET_MS;
    let visibleChunksChanged = false;
    while (true) {
      if (Date.now() > deadline) {
        // No time to perform chunk update now, we will wait some more.
        setTimeout(
          () => this.processPendingChunkUpdates(),
          CHUNK_UPDATE_DELAY_MS,
        );
        break;
      }
      const update = this.pendingChunkUpdates;
      if (update == null) break;
      try {
        if (this.applyChunkUpdate(update)) {
          visibleChunksChanged = true;
        }
      } finally {
        const nextUpdate = (this.pendingChunkUpdates = update.nextUpdate);
        if (nextUpdate == null) {
          this.pendingChunkUpdatesTail = null;
          break;
        }
      }
    }
    if (visibleChunksChanged) {
      this.visibleChunksChanged.dispatch();
    }
  }

  applyChunkUpdate(update: any) {
    let visibleChunksChanged = false;
    const { rpc } = this;
    const source = <ChunkSource>rpc!.get(update.source);
    if (source === undefined) {
      // Source was removed while chunk update was enqueued.
      return;
    }
    const newState: number = update.state;
    if (newState === ChunkState.EXPIRED) {
      // FIXME: maybe use freeList for chunks here
      source.deleteChunk(update.id);
    } else {
      let chunk: Chunk;
      const key = update.id;
      if (update.new) {
        chunk = source.getChunk(update);
        source.addChunk(key, chunk);
      } else {
        chunk = source.chunks.get(key)!;
      }
      const oldState = chunk.state;
      if (newState !== oldState) {
        switch (newState) {
          case ChunkState.GPU_MEMORY:
            chunk.copyToGPU(this.gl);
            visibleChunksChanged = true;
            break;
          case ChunkState.SYSTEM_MEMORY:
            if (oldState === ChunkState.GPU_MEMORY) {
              chunk.freeGPUMemory(this.gl);
            }
            break;
          default:
            throw new Error(
              `INTERNAL ERROR: Invalid chunk state: ${ChunkState[newState]}`,
            );
        }
      }
      if (newState <= ChunkState.SYSTEM_MEMORY) {
        const { chunkRequesters } = source;
        if (chunkRequesters !== undefined) {
          const requesters = chunkRequesters.get(key);
          if (requesters !== undefined) {
            for (const requester of requesters) {
              requester(chunk);
            }
          }
        }
      }
    }
    return visibleChunksChanged;
  }
}

registerRPC("Chunk.update", function (x) {
  const source: ChunkSource = this.get(x.source);
  const queueManager = source.chunkManager.chunkQueueManager;
  const pendingTail = queueManager.pendingChunkUpdatesTail;
  if (pendingTail == null) {
    queueManager.pendingChunkUpdates = x;
    queueManager.pendingChunkUpdatesTail = x;
    queueManager.scheduleChunkUpdate();
  } else {
    pendingTail.nextUpdate = x;
    queueManager.pendingChunkUpdatesTail = x;
  }
});

export type GettableChunkSource = SharedObject & { OPTIONS: object; key: any };

export interface ChunkSourceConstructor<
  T extends GettableChunkSource = GettableChunkSource,
> {
  new (...args: any[]): T;
  encodeOptions(options: T["OPTIONS"]): any;
}

@registerSharedObjectOwner(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObject {
  memoize = new StringMemoize();

  get gl() {
    return this.chunkQueueManager.gl;
  }

  constructor(public chunkQueueManager: ChunkQueueManager) {
    super();
    this.registerDisposer(chunkQueueManager.addRef());
    this.initializeCounterpart(chunkQueueManager.rpc!, {
      chunkQueueManager: chunkQueueManager.rpcId,
    });
  }

  /**
   * Returns the chunk source for `options`, creating it (and its worker counterpart) the first time.
   */
  getChunkSource<T extends GettableChunkSource>(
    constructorFunction: ChunkSourceConstructor<T>,
    options: any,
  ): T {
    const keyObject = constructorFunction.encodeOptions(options);
    keyObject.constructorId = getObjectId(constructorFunction);
    const key = stableStringify(keyObject);
    return this.memoize.get(key, () => {
      const newSource = new constructorFunction(this, options);
      newSource.initializeCounterpart(this.rpc!, {});
      newSource.key = keyObject;
      return newSource;
    });
  }
}

export interface ChunkRequesterState {
  (chunk: Chunk): void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ChunkSource extends SharedObject {
  OPTIONS: object;
  chunks = new Map<string, Chunk>();

  chunkRequesters: Map<string, ChunkRequesterState[]> | undefined;

  constructor(
    public chunkManager: Borrowed<ChunkManager>,
    _options: object = {},
  ) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.chunkManager = this.chunkManager.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  deleteChunk(key: string) {
    const chunk = this.chunks.get(key)!;
    if (chunk.state === ChunkState.GPU_MEMORY) {
      chunk.freeGPUMemory(this.gl);
    }
    this.chunks.delete(key);
  }

  addChunk(key: string, chunk: Chunk) {
    this.chunks.set(key, chunk);
  }

  /**
   * Default implementation for use with backendOnly chunk sources.
   */
  getChunk(_x: any): Chunk {
    throw new Error("Not implemented.");
  }

  static encodeOptions(_options: object): { [key: string]: any } {
    return {};
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ChunkSource {
  key: any;
}

export function WithParameters<
  Parameters,
  TBase extends ChunkSourceConstructor,
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  type WithParametersOptions = InstanceType<TBase>["OPTIONS"] & {
    parameters: Parameters;
  };
  @registerSharedObjectOwner(parametersConstructor.RPC_ID)
  class C extends Base {
    OPTIONS: WithParametersOptions;
    parameters: Parameters;
    constructor(...args: any[]) {
      super(...args);
      const options: WithParametersOptions = args[1];
      this.parameters = options.parameters;
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options.parameters = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static encodeOptions(options: WithParametersOptions) {
      return Object.assign(
        { parameters: options.parameters },
        Base.encodeOptions(options),
      );
    }
  }
  return C;
}
