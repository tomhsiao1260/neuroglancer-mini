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
 * @file Worker side of chunk management.
 *
 * Every chunk has a priority tier (VISIBLE, PREFETCH or RECENT) and a priority within the tier.
 * Layers call `ChunkManager.requestChunk` for the chunks they need each time priorities are
 * recomputed; chunks that are no longer requested fall back to RECENT.  `ChunkQueueManager` then
 * moves the highest-priority chunks forward through the states
 *
 *   QUEUED -> DOWNLOADING -> SYSTEM_MEMORY_WORKER -> GPU_MEMORY
 *
 * within the download, system memory and GPU memory capacities, evicting lower-priority chunks when
 * a capacity is full.  State changes that concern the main thread are sent as `Chunk.update`
 * messages (see `chunk_manager/frontend.ts`).
 */

import type { ChunkSourceParametersConstructor } from "#src/chunk_manager/base.js";
import {
  CHUNK_MANAGER_RPC_ID,
  CHUNK_QUEUE_MANAGER_RPC_ID,
  ChunkPriorityTier,
  ChunkState,
} from "#src/chunk_manager/base.js";
import type { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { CancellationTokenSource } from "#src/util/cancellation.js";
import type { Borrowed, Disposable } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import LinkedList0 from "#src/util/linked_list.0.js";
import LinkedList1 from "#src/util/linked_list.1.js";
import type { LinkedListOperations } from "#src/util/linked_list.js";
import PairingHeap0 from "#src/util/pairing_heap.0.js";
import PairingHeap1 from "#src/util/pairing_heap.1.js";
import type {
  ComparisonFunction,
  PairingHeapOperations,
} from "#src/util/pairing_heap.js";
import { NullarySignal } from "#src/util/signal.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  initializeSharedObjectCounterpart,
  registerSharedObject,
  registerSharedObjectOwner,
  SharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

export interface ChunkStateListener {
  (chunk: Chunk, oldState: ChunkState): void;
}

let nextMarkGeneration = 0;
export function getNextMarkGeneration() {
  return ++nextMarkGeneration;
}

export class Chunk implements Disposable {
  // Node properties used for eviction/promotion heaps and LRU linked lists.  A chunk can be in two
  // queues at once: one using the `0` fields and one using the `1` fields.
  child0: Chunk | null = null;
  next0: Chunk | null = null;
  prev0: Chunk | null = null;
  child1: Chunk | null = null;
  next1: Chunk | null = null;
  prev1: Chunk | null = null;

  source: ChunkSource | null = null;

  key: string | null = null;

  private state_ = ChunkState.NEW;

  error: any = null;

  // Used by layers for marking chunks for various purposes.
  markGeneration = -1;

  /**
   * Specifies existing priority within priority tier.  Only meaningful if priorityTier in
   * CHUNK_ORDERED_PRIORITY_TIERS.  Higher numbers mean higher priority.
   */
  priority = 0;

  /**
   * Specifies updated priority within priority tier, not yet reflected in priority queue state.
   * Only meaningful if newPriorityTier in CHUNK_ORDERED_PRIORITY_TIERS.
   */
  newPriority = 0;

  priorityTier = ChunkPriorityTier.RECENT;

  /**
   * Specifies updated priority tier, not yet reflected in priority queue state.
   */
  newPriorityTier = ChunkPriorityTier.RECENT;

  private systemMemoryBytes_ = 0;
  private gpuMemoryBytes_ = 0;

  /**
   * Specifies lowest numeric state required by any request, if `prioritTier !==
   * ChunkPriorityTier.RECENT`, then this must be one of `GPU_MEMORY`, `SYSTEM_MEMORY`, or
   * `SYSTEM_MEMORY_WORKER`.
   */
  requestedState = ChunkState.NEW;

  newRequestedState = ChunkState.NEW;

  /**
   * Cancellation token used to cancel the pending download.  Set to undefined except when state !==
   * DOWNLOADING.  This should not be accessed by code outside this module.
   */
  downloadCancellationToken: CancellationTokenSource | undefined = undefined;

  initialize(key: string) {
    this.key = key;
    this.priority = Number.NEGATIVE_INFINITY;
    this.priorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.error = null;
    this.state = ChunkState.NEW;
    this.requestedState = ChunkState.NEW;
    this.newRequestedState = ChunkState.NEW;
  }

  /**
   * Sets this.priority{Tier,} to this.newPriority{Tier,}, and resets this.newPriorityTier to
   * ChunkPriorityTier.RECENT.
   *
   * This does not actually update any queues to reflect this change.
   */
  updatePriorityProperties() {
    this.priorityTier = this.newPriorityTier;
    this.priority = this.newPriority;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.requestedState = this.newRequestedState;
    this.newRequestedState = ChunkState.NEW;
  }

  dispose() {
    this.source = null;
    this.error = null;
  }

  get chunkManager() {
    return (<ChunkSource>this.source).chunkManager;
  }

  get queueManager() {
    return (<ChunkSource>this.source).chunkManager.queueManager;
  }

  downloadFailed(error: any) {
    this.error = error;
    this.queueManager.updateChunkState(this, ChunkState.FAILED);
  }

  downloadSucceeded() {
    if (this.requestedState === ChunkState.SYSTEM_MEMORY) {
      this.queueManager.moveChunkToFrontend(this);
      this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY);
    } else {
      this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
    }
  }

  freeSystemMemory() {}

  serialize(msg: any, _transfers: any[]) {
    msg.id = this.key;
    msg.source = (<ChunkSource>this.source).rpcId;
    msg.new = true;
  }

  toString() {
    return this.key;
  }

  set state(newState: ChunkState) {
    if (newState === this.state_) {
      return;
    }
    const oldState = this.state_;
    this.state_ = newState;
    this.source!.chunkStateChanged(this, oldState);
  }

  get state() {
    return this.state_;
  }

  set systemMemoryBytes(bytes: number) {
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.systemMemoryBytes_ = bytes;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  get systemMemoryBytes() {
    return this.systemMemoryBytes_;
  }

  set gpuMemoryBytes(bytes: number) {
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.gpuMemoryBytes_ = bytes;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  get gpuMemoryBytes() {
    return this.gpuMemoryBytes_;
  }

  static priorityLess(a: Chunk, b: Chunk) {
    return a.priority < b.priority;
  }

  static priorityGreater(a: Chunk, b: Chunk) {
    return a.priority > b.priority;
  }
}

export interface ChunkConstructor<T extends Chunk> {
  new (): T;
}

/**
 * Worker counterpart of a frontend `ChunkSource`.  Holds the chunks of one source (e.g. one scale
 * of a volume) keyed by chunk key, and downloads them with `download`.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ChunkSource extends SharedObject {
  private listeners_ = new Map<string, ChunkStateListener[]>();
  chunks: Map<string, Chunk> = new Map<string, Chunk>();
  // Chunk objects removed from `chunks`, kept for reuse.
  freeChunks: Chunk[] = new Array<Chunk>();
  chunkManager: Borrowed<ChunkManager>;

  constructor(rpc: RPC, options: any) {
    super();
    // No need to add a reference, since the owner counterpart will hold a reference to the owner
    // counterpart of chunkManager.
    this.chunkManager = <ChunkManager>rpc.get(options.chunkManager);
    initializeSharedObjectCounterpart(this, rpc, options);
  }

  getNewChunk_<T extends Chunk>(chunkType: ChunkConstructor<T>): T {
    const freeChunks = this.freeChunks;
    const freeChunksLength = freeChunks.length;
    if (freeChunksLength > 0) {
      const chunk = <T>freeChunks[freeChunksLength - 1];
      freeChunks.length = freeChunksLength - 1;
      chunk.source = this;
      return chunk;
    }
    const chunk = new chunkType();
    chunk.source = this;
    return chunk;
  }

  /**
   * Adds the specified chunk to the chunk cache.
   *
   * If the chunk cache was previously empty, also call this.addRef() to increment the reference
   * count.
   */
  addChunk(chunk: Chunk) {
    const { chunks } = this;
    if (chunks.size === 0) {
      this.addRef();
    }
    chunks.set(chunk.key!, chunk);
  }

  /**
   * Remove the specified chunk from the chunk cache.
   *
   * If the chunk cache becomes empty, also call this.dispose() to decrement the reference count.
   */
  removeChunk(chunk: Chunk) {
    const { chunks, freeChunks } = this;
    chunks.delete(chunk.key!);
    chunk.dispose();
    freeChunks[freeChunks.length] = chunk;
    if (chunks.size === 0) {
      this.dispose();
    }
  }

  registerChunkListener(key: string, listener: ChunkStateListener) {
    if (!this.listeners_.has(key)) {
      this.listeners_.set(key, [listener]);
    } else {
      this.listeners_.get(key)!.push(listener);
    }
    return true;
  }

  unregisterChunkListener(key: string, listener: ChunkStateListener) {
    if (!this.listeners_.has(key)) {
      return false;
    }
    const keyListeners = this.listeners_.get(key)!;
    const idx = keyListeners.indexOf(listener);
    if (idx < 0) {
      return false;
    }
    keyListeners.splice(idx, 1);
    if (keyListeners.length === 0) {
      this.listeners_.delete(key);
    }
    return true;
  }

  chunkStateChanged(chunk: Chunk, oldState: ChunkState) {
    const { key } = chunk;
    if (key === null) return;
    const listeners = this.listeners_.get(key);
    if (listeners === undefined) return;
    for (const listener of listeners.slice()) {
      listener(chunk, oldState);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ChunkSource {
  /**
   * Begin downloading the specified the chunk.  The returned promise should resolve when the
   * downloaded data has been successfully decoded and stored in the chunk, or rejected if the
   * download or decoding fails.
   *
   * Note: This method must be defined by subclasses.
   *
   * @param chunk Chunk to download.
   * @param cancellationToken If this token is canceled, the download/decoding should be aborted if
   * possible.
   */
  download(chunk: Chunk, cancellationToken: CancellationToken): Promise<void>;
}

function startChunkDownload(chunk: Chunk) {
  const downloadCancellationToken = (chunk.downloadCancellationToken =
    new CancellationTokenSource());
  chunk.source!.download(chunk, downloadCancellationToken).then(
    () => {
      if (chunk.downloadCancellationToken === downloadCancellationToken) {
        chunk.downloadCancellationToken = undefined;
        chunk.downloadSucceeded();
      }
    },
    (error: any) => {
      if (chunk.downloadCancellationToken === downloadCancellationToken) {
        chunk.downloadCancellationToken = undefined;
        chunk.downloadFailed(error);
        console.log(`Error retrieving chunk ${chunk}: ${error}`);
      }
    },
  );
}

function cancelChunkDownload(chunk: Chunk) {
  const token = chunk.downloadCancellationToken!;
  chunk.downloadCancellationToken = undefined;
  token.cancel();
}

/**
 * Chunks ordered by priority tier and priority: a pairing heap for each of the VISIBLE and PREFETCH
 * tiers, and a linked list (most recently added first) for the RECENT tier.
 */
class ChunkPriorityQueue {
  /**
   * Heap roots for VISIBLE and PREFETCH priority tiers.
   */
  private heapRoots: (Chunk | null)[] = [null, null];

  /**
   * Head node for RECENT linked list.
   */
  private recentHead = new Chunk();
  constructor(
    private heapOperations: PairingHeapOperations<Chunk>,
    private linkedListOperations: LinkedListOperations<Chunk>,
  ) {
    linkedListOperations.initializeHead(this.recentHead);
  }

  add(chunk: Chunk) {
    const priorityTier = chunk.priorityTier;
    if (priorityTier === ChunkPriorityTier.RECENT) {
      this.linkedListOperations.insertAfter(this.recentHead, chunk);
    } else {
      const { heapRoots } = this;
      heapRoots[priorityTier] = this.heapOperations.meld(
        heapRoots[priorityTier],
        chunk,
      );
    }
  }

  /**
   * Yields chunks from lowest to highest priority for eviction queues (ordered by `priorityLess`),
   * and from highest to lowest priority for promotion queues.
   */
  *candidates(): Iterator<Chunk> {
    if (this.heapOperations.compare === Chunk.priorityLess) {
      // Start with least-recently used RECENT chunk.
      const { linkedListOperations, recentHead } = this;
      while (true) {
        const chunk = linkedListOperations.back(recentHead);
        if (chunk == null) {
          break;
        }
        yield chunk;
      }
      const { heapRoots } = this;
      for (
        let tier = ChunkPriorityTier.LAST_ORDERED_TIER;
        tier >= ChunkPriorityTier.FIRST_ORDERED_TIER;
        --tier
      ) {
        while (true) {
          const root = heapRoots[tier];
          if (root == null) {
            break;
          }
          yield root;
        }
      }
    } else {
      const heapRoots = this.heapRoots;
      for (
        let tier = ChunkPriorityTier.FIRST_ORDERED_TIER;
        tier <= ChunkPriorityTier.LAST_ORDERED_TIER;
        ++tier
      ) {
        while (true) {
          const root = heapRoots[tier];
          if (root == null) {
            break;
          }
          yield root;
        }
      }
      const { linkedListOperations, recentHead } = this;
      while (true) {
        const chunk = linkedListOperations.front(recentHead);
        if (chunk == null) {
          break;
        }
        yield chunk;
      }
    }
  }

  /**
   * Deletes a chunk from this priority queue.
   * @param chunk The chunk to delete from the priority queue.
   */
  delete(chunk: Chunk) {
    const priorityTier = chunk.priorityTier;
    if (priorityTier === ChunkPriorityTier.RECENT) {
      this.linkedListOperations.pop(chunk);
    } else {
      const heapRoots = this.heapRoots;
      heapRoots[priorityTier] = this.heapOperations.remove(
        <Chunk>heapRoots[priorityTier],
        chunk,
      );
    }
  }
}

function makeChunkPriorityQueue0(compare: ComparisonFunction<Chunk>) {
  return new ChunkPriorityQueue(new PairingHeap0(compare), LinkedList0);
}

function makeChunkPriorityQueue1(compare: ComparisonFunction<Chunk>) {
  return new ChunkPriorityQueue(new PairingHeap1(compare), LinkedList1);
}

/**
 * Evicts candidates until `capacity` has room for one item of `size` bytes.  Returns false, without
 * evicting further, once the next candidate has a priority at least as high as the chunk to be
 * promoted.
 */
function tryToFreeCapacity(
  size: number,
  capacity: AvailableCapacity,
  priorityTier: ChunkPriorityTier,
  priority: number,
  evictionCandidates: Iterator<Chunk>,
  evict: (chunk: Chunk) => void,
) {
  while (capacity.availableItems < 1 || capacity.availableSize < size) {
    const evictionCandidate = evictionCandidates.next().value;
    if (evictionCandidate === undefined) {
      // No eviction candidates available, promotions are done.
      return false;
    }
    const evictionTier = evictionCandidate.priorityTier;
    if (
      evictionTier < priorityTier ||
      (evictionTier === priorityTier && evictionCandidate.priority >= priority)
    ) {
      // Lowest priority eviction candidate has priority >= highest
      // priority promotion candidate.  No more promotions are
      // possible.
      return false;
    }
    evict(evictionCandidate);
  }
  return true;
}

class AvailableCapacity extends RefCounted {
  currentSize = 0;
  currentItems = 0;

  capacityChanged = new NullarySignal();

  constructor(
    public itemLimit: Borrowed<SharedWatchableValue<number>>,
    public sizeLimit: Borrowed<SharedWatchableValue<number>>,
  ) {
    super();
    this.registerDisposer(itemLimit.changed.add(this.capacityChanged.dispatch));
    this.registerDisposer(sizeLimit.changed.add(this.capacityChanged.dispatch));
  }

  /**
   * Adjust available capacity by the specified amounts.
   */
  adjust(items: number, size: number) {
    this.currentItems -= items;
    this.currentSize -= size;
  }

  get availableSize() {
    return this.sizeLimit.value - this.currentSize;
  }
  get availableItems() {
    return this.itemLimit.value - this.currentItems;
  }
}

@registerSharedObject(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObjectCounterpart {
  gpuMemoryCapacity: AvailableCapacity;
  systemMemoryCapacity: AvailableCapacity;
  downloadCapacity: AvailableCapacity;

  enablePrefetch: SharedWatchableValue<boolean>;

  /**
   * Contains all chunks in QUEUED state pending download.
   */
  private queuedDownloadPromotionQueue = makeChunkPriorityQueue1(
    Chunk.priorityGreater,
  );

  /**
   * Contains all chunks in DOWNLOADING state.
   */
  private downloadEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

  /**
   * Contains all chunks that take up memory (DOWNLOADING, SYSTEM_MEMORY,
   * GPU_MEMORY).
   */
  private systemMemoryEvictionQueue = makeChunkPriorityQueue0(
    Chunk.priorityLess,
  );

  /**
   * Contains all chunks in SYSTEM_MEMORY state not in RECENT priority tier.
   */
  private gpuMemoryPromotionQueue = makeChunkPriorityQueue1(
    Chunk.priorityGreater,
  );

  /**
   * Contains all chunks in GPU_MEMORY state.
   */
  private gpuMemoryEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

  // Should be `number|null`, but marked `any` to work around @types/node being pulled in.
  private updatePending: any = null;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    const getCapacity = (capacity: any) => {
      const result = this.registerDisposer(
        new AvailableCapacity(
          rpc.get(capacity.itemLimit),
          rpc.get(capacity.sizeLimit),
        ),
      );
      result.capacityChanged.add(() => this.scheduleUpdate());
      return result;
    };
    this.gpuMemoryCapacity = getCapacity(options.gpuMemoryCapacity);
    this.systemMemoryCapacity = getCapacity(options.systemMemoryCapacity);
    this.enablePrefetch = rpc.get(options.enablePrefetch);
    this.downloadCapacity = getCapacity(options.downloadCapacity);
  }

  scheduleUpdate() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(this.process.bind(this), 0);
    }
  }

  *chunkQueuesForChunk(chunk: Chunk) {
    switch (chunk.state) {
      case ChunkState.QUEUED:
        yield this.queuedDownloadPromotionQueue;
        break;

      case ChunkState.DOWNLOADING:
        yield this.downloadEvictionQueue;
        yield this.systemMemoryEvictionQueue;
        break;

      case ChunkState.SYSTEM_MEMORY_WORKER:
      case ChunkState.SYSTEM_MEMORY:
        yield this.systemMemoryEvictionQueue;
        if (chunk.requestedState === ChunkState.GPU_MEMORY) {
          yield this.gpuMemoryPromotionQueue;
        }
        break;

      case ChunkState.GPU_MEMORY:
        yield this.systemMemoryEvictionQueue;
        yield this.gpuMemoryEvictionQueue;
        break;
    }
  }

  adjustCapacitiesForChunk(chunk: Chunk, add: boolean) {
    const factor = add ? -1 : 1;
    switch (chunk.state) {
      case ChunkState.DOWNLOADING:
        this.downloadCapacity.adjust(factor, factor * chunk.systemMemoryBytes);
        this.systemMemoryCapacity.adjust(
          factor,
          factor * chunk.systemMemoryBytes,
        );
        break;

      case ChunkState.SYSTEM_MEMORY:
      case ChunkState.SYSTEM_MEMORY_WORKER:
        this.systemMemoryCapacity.adjust(
          factor,
          factor * chunk.systemMemoryBytes,
        );
        break;

      case ChunkState.GPU_MEMORY:
        this.systemMemoryCapacity.adjust(
          factor,
          factor * chunk.systemMemoryBytes,
        );
        this.gpuMemoryCapacity.adjust(factor, factor * chunk.gpuMemoryBytes);
        break;
    }
  }

  private removeChunkFromQueues_(chunk: Chunk) {
    for (const queue of this.chunkQueuesForChunk(chunk)) {
      queue.delete(chunk);
    }
  }

  private addChunkToQueues_(chunk: Chunk) {
    if (
      chunk.state === ChunkState.QUEUED &&
      chunk.priorityTier === ChunkPriorityTier.RECENT
    ) {
      // Delete this chunk.
      const { source } = chunk;
      source!.removeChunk(chunk);
      this.adjustCapacitiesForChunk(chunk, false);
      return false;
    }
    for (const queue of this.chunkQueuesForChunk(chunk)) {
      queue.add(chunk);
    }
    return true;
  }

  performChunkPriorityUpdate(chunk: Chunk) {
    if (
      chunk.priorityTier === chunk.newPriorityTier &&
      chunk.priority === chunk.newPriority
    ) {
      chunk.newPriorityTier = ChunkPriorityTier.RECENT;
      chunk.newPriority = Number.NEGATIVE_INFINITY;
      return;
    }
    this.removeChunkFromQueues_(chunk);
    chunk.updatePriorityProperties();
    if (chunk.state === ChunkState.NEW) {
      chunk.state = ChunkState.QUEUED;
      this.adjustCapacitiesForChunk(chunk, true);
    }
    this.addChunkToQueues_(chunk);
  }

  updateChunkState(chunk: Chunk, newState: ChunkState) {
    if (newState === chunk.state) {
      return;
    }
    this.adjustCapacitiesForChunk(chunk, false);
    this.removeChunkFromQueues_(chunk);
    chunk.state = newState;
    this.adjustCapacitiesForChunk(chunk, true);
    this.addChunkToQueues_(chunk);
    this.scheduleUpdate();
  }

  // Copies the highest-priority chunks in system memory to the GPU, evicting lower-priority chunks
  // from the GPU as needed.
  private processGPUPromotions_() {
    const queueManager = this;
    function evictFromGPUMemory(chunk: Chunk) {
      queueManager.freeChunkGPUMemory(chunk);
      chunk.source!.chunkManager.queueManager.updateChunkState(
        chunk,
        ChunkState.SYSTEM_MEMORY,
      );
    }
    const promotionCandidates = this.gpuMemoryPromotionQueue.candidates();
    const evictionCandidates = this.gpuMemoryEvictionQueue.candidates();
    const capacity = this.gpuMemoryCapacity;
    while (true) {
      const promotionCandidate = promotionCandidates.next().value;
      if (promotionCandidate === undefined) {
        break;
      }
      const priorityTier = promotionCandidate.priorityTier;
      const priority = promotionCandidate.priority;
      if (
        !tryToFreeCapacity(
          promotionCandidate.gpuMemoryBytes,
          capacity,
          priorityTier,
          priority,
          evictionCandidates,
          evictFromGPUMemory,
        )
      ) {
        break;
      }
      this.copyChunkToGPU(promotionCandidate);
      this.updateChunkState(promotionCandidate, ChunkState.GPU_MEMORY);
    }
  }

  freeChunkGPUMemory(chunk: Chunk) {
    this.rpc!.invoke("Chunk.update", {
      id: chunk.key,
      state: ChunkState.SYSTEM_MEMORY,
      source: chunk.source!.rpcId,
    });
  }

  freeChunkSystemMemory(chunk: Chunk) {
    if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
      chunk.freeSystemMemory();
    } else {
      this.rpc!.invoke("Chunk.update", {
        id: chunk.key,
        state: ChunkState.EXPIRED,
        source: chunk.source!.rpcId,
      });
    }
  }

  copyChunkToGPU(chunk: Chunk) {
    const rpc = this.rpc!;
    if (chunk.state === ChunkState.SYSTEM_MEMORY) {
      rpc.invoke("Chunk.update", {
        id: chunk.key,
        source: chunk.source!.rpcId,
        state: ChunkState.GPU_MEMORY,
      });
    } else {
      // The data is still in the worker: transfer it with the update.
      const msg: any = {};
      const transfers: any[] = [];
      chunk.serialize(msg, transfers);
      msg.state = ChunkState.GPU_MEMORY;
      rpc.invoke("Chunk.update", msg, transfers);
    }
  }

  moveChunkToFrontend(chunk: Chunk) {
    const rpc = this.rpc!;
    const msg: any = {};
    const transfers: any[] = [];
    chunk.serialize(msg, transfers);
    msg.state = ChunkState.SYSTEM_MEMORY;
    rpc.invoke("Chunk.update", msg, transfers);
  }

  // Starts downloading the highest-priority queued chunks, evicting lower-priority chunks from the
  // download slots and from system memory as needed.
  private processQueuePromotions_() {
    const evict = (chunk: Chunk) => {
      switch (chunk.state) {
        case ChunkState.DOWNLOADING:
          cancelChunkDownload(chunk);
          break;
        case ChunkState.GPU_MEMORY:
          this.freeChunkGPUMemory(chunk);
        // fallthrough
        case ChunkState.SYSTEM_MEMORY_WORKER:
        case ChunkState.SYSTEM_MEMORY:
          this.freeChunkSystemMemory(chunk);
          break;
      }
      // Note: After calling this, chunk may no longer be valid.
      this.updateChunkState(chunk, ChunkState.QUEUED);
    };

    const promotionCandidates = this.queuedDownloadPromotionQueue.candidates();
    const evictionCandidates = this.downloadEvictionQueue.candidates();
    const systemMemoryEvictionCandidates =
      this.systemMemoryEvictionQueue.candidates();
    while (true) {
      const promotionCandidateResult = promotionCandidates.next();
      if (promotionCandidateResult.done) {
        return;
      }
      const promotionCandidate = promotionCandidateResult.value;
      const size = 0; /* unknown size, since it hasn't been downloaded yet. */
      const priorityTier = promotionCandidate.priorityTier;
      const priority = promotionCandidate.priority;
      if (
        !tryToFreeCapacity(
          size,
          this.downloadCapacity,
          priorityTier,
          priority,
          evictionCandidates,
          evict,
        )
      ) {
        return;
      }
      if (
        !tryToFreeCapacity(
          size,
          this.systemMemoryCapacity,
          priorityTier,
          priority,
          systemMemoryEvictionCandidates,
          evict,
        )
      ) {
        return;
      }
      this.updateChunkState(promotionCandidate, ChunkState.DOWNLOADING);
      startChunkDownload(promotionCandidate);
    }
  }

  process() {
    if (!this.updatePending) {
      return;
    }
    this.updatePending = null;
    this.processGPUPromotions_();
    this.processQueuePromotions_();
  }
}

@registerSharedObject(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObjectCounterpart {
  queueManager: ChunkQueueManager;

  /**
   * Array of chunks within each existing priority tier.
   */
  private existingTierChunks: Chunk[][] = [];

  /**
   * Array of chunks whose new priorities have not yet been reflected in the
   * queue states.
   */
  private newTierChunks: Chunk[] = [];

  // Should be `number|null`, but marked `any` to workaround `@types/node` being pulled in.
  private updatePending: any = null;

  // Dispatched when priorities are recomputed; listeners call `requestChunk` for the chunks they
  // need.
  recomputeChunkPriorities = new NullarySignal();

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.queueManager = (<ChunkQueueManager>(
      rpc.get(options.chunkQueueManager)
    )).addRef();

    for (
      let tier = ChunkPriorityTier.FIRST_TIER;
      tier <= ChunkPriorityTier.LAST_TIER;
      ++tier
    ) {
      if (tier === ChunkPriorityTier.RECENT) {
        continue;
      }
      this.existingTierChunks[tier] = [];
    }
  }

  scheduleUpdateChunkPriorities() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(
        this.recomputeChunkPriorities_.bind(this),
        0,
      );
    }
  }

  private recomputeChunkPriorities_() {
    this.updatePending = null;
    this.recomputeChunkPriorities.dispatch();
    this.updateQueueState([
      ChunkPriorityTier.VISIBLE,
      ChunkPriorityTier.PREFETCH,
    ]);
  }

  /**
   * @param chunk
   * @param tier New priority tier.  Must not equal ChunkPriorityTier.RECENT.
   * @param priority Priority within tier.
   * @param requestedState Indicates requested chunk state.
   */
  requestChunk(
    chunk: Chunk,
    tier: ChunkPriorityTier,
    priority: number,
    requestedState: ChunkState = ChunkState.GPU_MEMORY,
  ) {
    if (Number.isNaN(priority)) {
      return;
    }
    if (tier === ChunkPriorityTier.RECENT) {
      throw new Error("Not going to request a chunk with the RECENT tier");
    }
    chunk.newRequestedState = Math.min(chunk.newRequestedState, requestedState);
    if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
      this.newTierChunks.push(chunk);
    }
    const newPriorityTier = chunk.newPriorityTier;
    if (
      tier < newPriorityTier ||
      (tier === newPriorityTier && priority > chunk.newPriority)
    ) {
      chunk.newPriorityTier = tier;
      chunk.newPriority = priority;
    }
  }

  /**
   * Update queue state to reflect updated contents of the specified priority tiers.  Existing
   * chunks within those tiers not present in this.newTierChunks will be moved to the RECENT tier
   * (and removed if in the QUEUED state).
   */
  updateQueueState(tiers: ChunkPriorityTier[]) {
    const existingTierChunks = this.existingTierChunks;
    const queueManager = this.queueManager;
    for (const tier of tiers) {
      const chunks = existingTierChunks[tier];
      for (const chunk of chunks) {
        if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
          // Downgrade the priority of this chunk.
          queueManager.performChunkPriorityUpdate(chunk);
        }
      }
      chunks.length = 0;
    }
    const newTierChunks = this.newTierChunks;
    for (const chunk of newTierChunks) {
      queueManager.performChunkPriorityUpdate(chunk);
      existingTierChunks[chunk.priorityTier].push(chunk);
    }
    newTierChunks.length = 0;
    this.queueManager.scheduleUpdate();
  }
}

/**
 * Mixin for adding a `parameters` member to a ChunkSource, and for registering the shared object
 * type based on the `RPC_ID` member of the Parameters class.
 */
export function WithParameters<
  Parameters,
  TBase extends { new (...args: any[]): SharedObject },
>(
  Base: TBase,
  parametersConstructor: ChunkSourceParametersConstructor<Parameters>,
) {
  @registerSharedObjectOwner(parametersConstructor.RPC_ID)
  class C extends Base {
    parameters: Parameters;
    constructor(...args: any[]) {
      super(...args);
      const options = args[1];
      this.parameters = options.parameters;
    }
  }
  return C;
}

/**
 * Interface that represents shared objects that request chunks from a ChunkManager.
 */
export interface ChunkRequester extends SharedObject {
  chunkManager: ChunkManager;
}

/**
 * Mixin that adds a chunkManager property initialized from the RPC-supplied options.
 *
 * The resultant class implements `ChunkRequester`.
 */
export function withChunkManager<
  T extends { new (...args: any[]): SharedObject },
>(Base: T) {
  return class extends Base implements ChunkRequester {
    chunkManager: ChunkManager;
    constructor(...args: any[]) {
      super(...args);
      const rpc: RPC = args[0];
      const options = args[1];
      // We don't increment the reference count, because our owner owns a reference to the
      // ChunkManager.
      this.chunkManager = <ChunkManager>rpc.get(options.chunkManager);
    }
  };
}
