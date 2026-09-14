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

import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import { resizeTexture } from "#src/webgl/texture.js";

/**
 * Framebuffer with an RGBA8 color texture and a 16-bit depth texture.  The textures are resized
 * when `bind` is called with a new size.
 */
export class OffscreenFramebuffer extends RefCounted {
  framebuffer: WebGLFramebuffer | null;
  colorTexture: WebGLTexture | null;
  depthTexture: WebGLTexture | null;
  private width = Number.NaN;
  private height = Number.NaN;
  private attachmentVerified = false;

  constructor(public gl: GL) {
    super();
    this.colorTexture = gl.createTexture();
    this.depthTexture = gl.createTexture();
    this.framebuffer = gl.createFramebuffer();
  }

  disposed() {
    const { gl } = this;
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteTexture(this.colorTexture);
    gl.deleteTexture(this.depthTexture);
  }

  // Binds the framebuffer and sets the viewport to cover all of it.
  bind(width: number, height: number) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      resizeTexture(
        gl,
        this.depthTexture,
        width,
        height,
        gl.DEPTH_COMPONENT16,
        gl.DEPTH_COMPONENT,
        gl.UNSIGNED_SHORT,
      );
      resizeTexture(
        gl,
        this.colorTexture,
        width,
        height,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
      );
    }
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      this.depthTexture,
      /*level=*/ 0,
    );
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.colorTexture,
      /*level=*/ 0,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    if (!this.attachmentVerified) {
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Framebuffer configuration not supported: ${status}`);
      }
      this.attachmentVerified = true;
    }
    gl.viewport(0, 0, width, height);
  }

  unbind() {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
