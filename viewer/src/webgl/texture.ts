/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { GL } from "#src/webgl/context.js";

/**
 * Sets parameters to make a texture suitable for use as a raw array: NEAREST
 * filtering, clamping.
 */
export function setRawTextureParameters(gl: WebGL2RenderingContext) {
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_2D,
    WebGL2RenderingContext.TEXTURE_MIN_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_2D,
    WebGL2RenderingContext.TEXTURE_MAG_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_2D,
    WebGL2RenderingContext.TEXTURE_WRAP_S,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_2D,
    WebGL2RenderingContext.TEXTURE_WRAP_T,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
}

export function setRawTexture3DParameters(gl: WebGL2RenderingContext) {
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_MIN_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_MAG_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_S,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_T,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_R,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
}

export function resizeTexture(
  gl: GL,
  texture: WebGLTexture | null,
  width: number,
  height: number,
  internalFormat: number = WebGL2RenderingContext.RGBA8,
  format: number = WebGL2RenderingContext.RGBA,
  dataType: number = WebGL2RenderingContext.UNSIGNED_BYTE,
) {
  gl.activeTexture(WebGL2RenderingContext.TEXTURE0 + gl.tempTextureUnit);
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, texture);
  setRawTextureParameters(gl);
  gl.texImage2D(
    WebGL2RenderingContext.TEXTURE_2D,
    0,
    /*internalformat=*/ internalFormat,
    /*width=*/ width,
    /*height=*/ height,
    /*border=*/ 0,
    /*format=*/ format,
    dataType,
    <any>null,
  );
  gl.bindTexture(WebGL2RenderingContext.TEXTURE_2D, null);
}

