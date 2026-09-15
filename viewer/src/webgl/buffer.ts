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
