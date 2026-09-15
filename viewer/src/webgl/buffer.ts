/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { Disposable } from "#src/util/disposable.js";

// A WebGL vertex (ARRAY_BUFFER) buffer.
export class Buffer implements Disposable {
  buffer: WebGLBuffer | null;

  constructor(public gl: WebGL2RenderingContext) {
    this.buffer = gl.createBuffer();
  }

  bind() {
    this.gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, this.buffer);
  }

  // Feeds float vertex attribute `location` from this buffer.
  bindToVertexAttrib(location: number, componentsPerVertexAttribute: number) {
    const { gl } = this;
    this.bind();
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      componentsPerVertexAttribute,
      WebGL2RenderingContext.FLOAT,
      /*normalized=*/ false,
      /*stride=*/ 0,
      /*offset=*/ 0,
    );
  }

  dispose() {
    this.gl.deleteBuffer(this.buffer);
  }

  static fromData(gl: WebGL2RenderingContext, data: ArrayBufferView) {
    const buffer = new Buffer(gl);
    buffer.bind();
    gl.bufferData(
      WebGL2RenderingContext.ARRAY_BUFFER,
      data,
      WebGL2RenderingContext.STATIC_DRAW,
    );
    return buffer;
  }
}
