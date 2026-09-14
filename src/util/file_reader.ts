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

import { cancellableFetchOk, isNotFoundError } from "#src/util/http_request.js";

export interface FileReadResponse {
  data: Uint8Array;
  totalSize: number;
}

export class SimpleFileReader {
  constructor(public baseUrl: string) {}

  async read(key: string): Promise<FileReadResponse | undefined> {
    const url = this.baseUrl + key;
    try {
      const { data } = await cancellableFetchOk(url, async (response) => ({
        response,
        data: await response.arrayBuffer(),
      }));
      return {
        data: new Uint8Array(data),
        totalSize: data.byteLength,
      };
    } catch (e) {
      // Chunks absent from a sparse volume are expected; only report other failures.
      if (!isNotFoundError(e)) {
        console.error(`Failed to read file: ${url}`, e);
      }
      return undefined;
    }
  }
}

export function getFileReader(baseUrl: string): SimpleFileReader {
  return new SimpleFileReader(baseUrl);
} 