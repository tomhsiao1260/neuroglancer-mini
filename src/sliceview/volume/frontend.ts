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
import type { SliceViewChunkSpecification } from "#src/sliceview/base.js";
import {
  MultiscaleSliceViewChunkSource,
  SliceViewChunk,
  SliceViewChunkSource,
} from "#src/sliceview/frontend.js";
import type {
  DataType,
  VolumeChunkSource as VolumeChunkSourceInterface,
  VolumeChunkSpecification,
} from "#src/sliceview/volume/base.js";
import {
  ChunkFormat,
  FillValueTexture,
  TextureLayout,
} from "#src/sliceview/volume/chunk_format.js";
import type { TypedArray } from "#src/util/array.js";
import type { GL } from "#src/webgl/context.js";

export class VolumeChunkSource
  extends SliceViewChunkSource<VolumeChunkSpecification, VolumeChunk>
  implements VolumeChunkSourceInterface
{
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

  static encodeSpec(spec: SliceViewChunkSpecification) {
    const s = spec as VolumeChunkSpecification;
    return {
      ...super.encodeSpec(spec),
      dataType: s.dataType,
    };
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
