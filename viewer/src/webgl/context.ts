/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { RefCounted } from "#src/util/disposable.js";
import { Memoize } from "#src/util/memoize.js";

export interface GL extends WebGL2RenderingContext {
  memoize: Memoize<any, RefCounted>;
  maxTextureSize: number;
  max3dTextureSize: number;
}

export function initializeWebGL(canvas: HTMLCanvasElement) {
  const options = {
    antialias: false,
    stencil: true,
  };
  const gl = <GL>canvas.getContext("webgl2", options);
  if (gl == null) {
    throw new Error("WebGL not supported.");
  }
  gl.memoize = new Memoize<any, RefCounted>();
  gl.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.max3dTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);

  for (const extension of ["EXT_color_buffer_float"]) {
    if (!gl.getExtension(extension)) {
      throw new Error(`${extension} extension not available`);
    }
  }

  // Extensions to attempt to add but not fail if they are not available.
  for (const extension of [
    // Some versions of Firefox 67.0 seem to require this extension being added in addition
    // to EXT_color_buffer_float, despite the note here indicating it is unnecessary:
    // https://developer.mozilla.org/en-US/docs/Web/API/EXT_float_blend
    //
    // See https://github.com/google/neuroglancer/issues/140
    "EXT_float_blend",
  ]) {
    gl.getExtension(extension);
  }
  return gl;
}
