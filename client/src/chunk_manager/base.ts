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
 * Where a chunk is.  States with lower numbers are closer to being drawn; code compares states
 * numerically (e.g. `state <= SYSTEM_MEMORY` means the main thread has the data).
 */
export enum ChunkState {
  // Chunk is stored in GPU memory in addition to system memory.
  GPU_MEMORY = 0,
  // Chunk is stored only in system memory but not in GPU memory.
  SYSTEM_MEMORY = 1,

  // Chunk is stored in system memory on worker.
  SYSTEM_MEMORY_WORKER = 2,

  // Chunk is downloading.
  DOWNLOADING = 3,
  // Chunk is not yet downloading.
  QUEUED = 4,

  // Chunk has just been added.
  NEW = 5,

  // Download failed.
  FAILED = 6,

  // Chunk was evicted; the main thread should delete it.
  EXPIRED = 7,
}

/**
 * Why a chunk is wanted.  Lower tiers always win over higher tiers; within the VISIBLE and PREFETCH
 * tiers chunks are ordered by a numeric priority.  RECENT chunks are no longer requested and are
 * kept in least-recently-used order until evicted.
 */
export enum ChunkPriorityTier {
  FIRST_TIER = 0,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  FIRST_ORDERED_TIER = 0,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  VISIBLE = 0,
  PREFETCH = 1,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  LAST_ORDERED_TIER = 1,
  RECENT = 2,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  LAST_TIER = 2,
}

export const CHUNK_QUEUE_MANAGER_RPC_ID = "ChunkQueueManager";
export const CHUNK_MANAGER_RPC_ID = "ChunkManager";
// Asks the worker to discard a chunk and download it again.
export const CHUNK_RELOAD_RPC_ID = "ChunkSource.reloadChunk";

export interface ChunkSourceParametersConstructor<T> {
  new (): T;
  RPC_ID: string;
}
