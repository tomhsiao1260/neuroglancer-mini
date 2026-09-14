/**
 * @license
 * Copyright 2023 Google Inc.
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

import Blosc from "numcodecs/blosc";
import type { Configuration } from "#src/datasource/zarr/codec/blosc/resolve.js";
import { CodecKind } from "#src/datasource/zarr/codec/index.js";
import { registerCodec } from "#src/datasource/zarr/codec/simple_decode.js";
import type { CancellationToken } from "#src/util/cancellation.js";

// The blosc header stores the compressor, shuffle and type size, so decoding needs no
// configuration.
const blosc = Blosc.fromConfig({ id: "blosc" });

registerCodec({
  name: "blosc",
  kind: CodecKind.bytesToBytes,
  async decode(
    configuration: Configuration,
    encoded: Uint8Array,
    cancellationToken: CancellationToken,
  ): Promise<Uint8Array> {
    configuration;
    cancellationToken;
    return blosc.decode(encoded);
  },
});
