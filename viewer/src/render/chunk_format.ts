/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file How volume chunks are stored on the GPU and read back in the fragment shader.
 *
 * Each chunk is uploaded as one texture with one texel per voxel: a 3-D texture if the chunk has at
 * least three dimensions of size > 1, otherwise a 2-D texture.  `TextureLayout` gives the texel
 * offset of each chunk dimension, and the shader turns a voxel position into a texel position with
 * it.
 */

import type { VolumeChunk } from "#src/render/frontend.js";
import type { TypedArray, TypedArrayConstructor } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import {
  dataTypeShaderDefinition,
  getShaderType,
} from "#src/webgl/shader_lib.js";
import {
  setRawTexture3DParameters,
  setRawTextureParameters,
} from "#src/webgl/texture.js";

const WebGL = WebGL2RenderingContext;

interface TextureFormat {
  internalFormat: number;
  format: number;
  texelType: number;
  arrayConstructor: TypedArrayConstructor;
  // Prefix of the sampler type: `usampler3D` or `sampler3D`.
  samplerPrefix: "" | "u";
}

const textureFormats: Record<DataType, TextureFormat> = {
  [DataType.UINT8]: {
    internalFormat: WebGL.R8UI,
    format: WebGL.RED_INTEGER,
    texelType: WebGL.UNSIGNED_BYTE,
    arrayConstructor: Uint8Array,
    samplerPrefix: "u",
  },
  [DataType.UINT16]: {
    internalFormat: WebGL.R16UI,
    format: WebGL.RED_INTEGER,
    texelType: WebGL.UNSIGNED_SHORT,
    arrayConstructor: Uint16Array,
    samplerPrefix: "u",
  },
  [DataType.FLOAT32]: {
    internalFormat: WebGL.R32F,
    format: WebGL.RED,
    texelType: WebGL.FLOAT,
    arrayConstructor: Float32Array,
    samplerPrefix: "",
  },
};

/**
 * Where the voxels of a chunk go in its texture.  Moving one voxel along chunk dimension `d` moves
 * `strides[d * textureDims + t]` texels along texture dimension `t`.  Chunk dimensions of size 1
 * take no texture dimension; dimensions are combined into one texture dimension when that stays
 * within the maximum texture size.
 */
export class TextureLayout {
  strides: Uint32Array;
  textureShape: Uint32Array;

  constructor(gl: GL, chunkDataSize: Uint32Array, textureDims: number) {
    const rank = chunkDataSize.length;
    let numRemainingDims = 0;
    for (const size of chunkDataSize) {
      if (size !== 1) ++numRemainingDims;
    }
    const strides = (this.strides = new Uint32Array(rank * textureDims));
    const textureShape = (this.textureShape = new Uint32Array(textureDims));
    const maxTextureSize =
      textureDims === 3 ? gl.max3dTextureSize : gl.maxTextureSize;
    let textureDim = 0;
    let textureDimSize = 1;
    textureShape.fill(1);
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const size = chunkDataSize[chunkDim];
      if (size === 1) continue;
      const newSize = size * textureDimSize;
      let stride: number;
      if (
        newSize > maxTextureSize ||
        (textureDimSize !== 1 && textureDim + numRemainingDims < textureDims)
      ) {
        ++textureDim;
        textureDimSize = size;
        stride = 1;
      } else {
        stride = textureDimSize;
        textureDimSize = newSize;
      }
      strides[textureDims * chunkDim + textureDim] = stride;
      textureShape[textureDim] = textureDimSize;
    }
  }
}

const tempStrides = new Int32Array(4 * 3);

/**
 * Uploads chunk data of one data type to textures, and defines and feeds the shader code that reads
 * them.  Shared by all chunk sources with the same data type and texture dimensionality.
 */
export class ChunkFormat extends RefCounted {
  textureFormat: TextureFormat;
  textureTarget: number;
  // Layout whose strides are currently set in the shader.
  private boundTextureLayout: TextureLayout | null = null;

  static get(gl: GL, dataType: DataType, textureDims: number) {
    return gl.memoize.get(
      `sliceview.ChunkFormat:${dataType}:${textureDims}`,
      () => new ChunkFormat(dataType, textureDims),
    );
  }

  constructor(
    public dataType: DataType,
    public textureDims: number,
  ) {
    super();
    this.textureFormat = textureFormats[dataType];
    this.textureTarget =
      textureDims === 3 ? WebGL.TEXTURE_3D : WebGL.TEXTURE_2D;
  }

  /**
   * Defines `getDataValue()`, the value of the voxel containing `vChunkPosition` in the chunk bound
   * with `bindChunk`.  The texture is read from texture unit 0.
   */
  defineShader(builder: ShaderBuilder) {
    const { dataType, textureDims } = this;
    const shaderType = getShaderType(dataType);
    const offsetType = `ivec${textureDims}`;
    builder.addUniform(
      `highp ${this.textureFormat.samplerPrefix}sampler${textureDims}D`,
      "uVolumeChunkSampler",
    );
    builder.addInitializer((shader) => {
      shader.gl.uniform1i(shader.uniform("uVolumeChunkSampler"), 0);
    });
    // Texel offset of voxel (0, 0, 0), then the texel offset per voxel along x, y and z.
    builder.addUniform(`highp ${offsetType}`, "uVolumeChunkStrides", 4);
    const readValue =
      dataType === DataType.FLOAT32
        ? "return texelFetch(uVolumeChunkSampler, offset, 0).r;"
        : `${shaderType} result;
  result.value = texelFetch(uVolumeChunkSampler, offset, 0).r;
  return result;`;
    builder.addFragmentCode([
      dataTypeShaderDefinition[dataType],
      `
${shaderType} getDataValue() {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(vChunkPosition), uChunkDataSize - 1.0)));
  highp ${offsetType} offset = uVolumeChunkStrides[0]
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3];
  ${readValue}
}
`,
    ]);
  }

  // Called with the shader bound, before the chunks of this format are drawn.
  beginDrawing(gl: GL) {
    gl.activeTexture(WebGL.TEXTURE0);
    this.boundTextureLayout = null;
  }

  endDrawing(gl: GL) {
    gl.bindTexture(this.textureTarget, null);
    this.boundTextureLayout = null;
  }

  // Called before drawing each chunk.  `newSource` is true for the first chunk of each source.
  bindChunk(
    gl: GL,
    shader: ShaderProgram,
    chunk: VolumeChunk,
    fixedChunkPosition: Uint32Array,
    chunkDisplaySubspaceDimensions: readonly number[],
    newSource: boolean,
  ) {
    const textureLayout = chunk.textureLayout!;
    if (this.boundTextureLayout !== textureLayout || newSource) {
      this.boundTextureLayout = textureLayout;
      this.setupTextureLayout(
        gl,
        shader,
        textureLayout,
        fixedChunkPosition,
        chunkDisplaySubspaceDimensions,
      );
    }
    gl.bindTexture(this.textureTarget, chunk.texture);
  }

  private setupTextureLayout(
    gl: GL,
    shader: ShaderProgram,
    textureLayout: TextureLayout,
    fixedChunkPosition: Uint32Array,
    chunkDisplaySubspaceDimensions: readonly number[],
  ) {
    const stridesUniform = tempStrides;
    const { strides } = textureLayout;
    const rank = fixedChunkPosition.length;
    const { textureDims } = this;
    for (let i = 0; i < textureDims; ++i) {
      let sum = 0;
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        sum +=
          fixedChunkPosition[chunkDim] * strides[chunkDim * textureDims + i];
      }
      stridesUniform[i] = sum;
    }
    for (let i = 0; i < 3; ++i) {
      const chunkDim = chunkDisplaySubspaceDimensions[i];
      if (chunkDim >= rank) continue;
      for (let j = 0; j < textureDims; ++j) {
        stridesUniform[(i + 1) * textureDims + j] =
          strides[chunkDim * textureDims + j];
      }
    }
    const location = shader.uniform("uVolumeChunkStrides");
    const length = 4 * textureDims;
    if (textureDims === 3) {
      gl.uniform3iv(location, stridesUniform, 0, length);
    } else {
      gl.uniform2iv(location, stridesUniform, 0, length);
    }
  }

  // Uploads `data` to the texture currently bound to `textureTarget`.
  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    const { internalFormat, format, texelType, arrayConstructor } =
      this.textureFormat;
    if (data.constructor !== arrayConstructor) {
      data = new arrayConstructor(
        data.buffer,
        data.byteOffset,
        data.byteLength / arrayConstructor.BYTES_PER_ELEMENT,
      );
    }
    gl.pixelStorei(WebGL.UNPACK_ALIGNMENT, 1);
    const { textureShape } = textureLayout;
    if (this.textureDims === 3) {
      setRawTexture3DParameters(gl);
      gl.texImage3D(
        WebGL.TEXTURE_3D,
        /*level=*/ 0,
        internalFormat,
        textureShape[0],
        textureShape[1],
        textureShape[2],
        /*border=*/ 0,
        format,
        texelType,
        data,
      );
    } else {
      setRawTextureParameters(gl);
      gl.texImage2D(
        WebGL.TEXTURE_2D,
        /*level=*/ 0,
        internalFormat,
        textureShape[0],
        textureShape[1],
        /*border=*/ 0,
        format,
        texelType,
        data,
      );
    }
  }
}

/**
 * A chunk missing from the store arrives with no data.  All such chunks share this single-voxel
 * texture holding 0, so a sparse volume does not allocate a texture per chunk.
 */
export class FillValueTexture extends RefCounted {
  texture: WebGLTexture | null;
  textureLayout: TextureLayout;

  constructor(gl: GL, chunkFormat: ChunkFormat, rank: number) {
    super();
    const { textureDims, textureTarget, textureFormat } = chunkFormat;
    const chunkSizeInVoxels = new Uint32Array(rank);
    chunkSizeInVoxels.fill(1);
    const textureLayout = (this.textureLayout = new TextureLayout(
      gl,
      chunkSizeInVoxels,
      textureDims,
    ));
    textureLayout.strides.fill(0);
    const texture = (this.texture = gl.createTexture());
    gl.bindTexture(textureTarget, texture);
    chunkFormat.setTextureData(
      gl,
      textureLayout,
      new textureFormat.arrayConstructor(1),
    );
    gl.bindTexture(textureTarget, null);
  }

  static get(gl: GL, chunkFormat: ChunkFormat, rank: number) {
    return gl.memoize.get(
      `sliceview.FillValueTexture:${rank}:${chunkFormat.dataType}:${chunkFormat.textureDims}`,
      () => new FillValueTexture(gl, chunkFormat, rank),
    );
  }
}
