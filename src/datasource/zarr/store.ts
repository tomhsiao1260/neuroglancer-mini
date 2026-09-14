/**
 * @license
 * Copyright 2020 Google Inc.
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
 * @file Where the files of a zarr store are read from.
 *
 * A file is addressed by its path relative to the root of the store, e.g. `.zattrs`, `0/.zarray` or
 * `0/52/24/18`.  The main thread reads the metadata and the worker reads the chunks, so a store is
 * described by a `ZarrStoreSpec`, which can be sent to the worker, and each thread creates its own
 * `ZarrStore` from it with `createZarrStore`.
 *
 * To read a store from anywhere else (a remote bucket, a custom server, ...), serve its files over
 * HTTP, answering 404 for missing files, and use an `http` spec.
 */

export interface ZarrStore {
  /**
   * Returns the contents of the file at `key`, or `undefined` if there is no such file.  Other
   * failures, such as network errors, reject.
   */
  get(key: string): Promise<Uint8Array | undefined>;
}

export type ZarrStoreSpec =
  // Files served over HTTP; `url` is the URL of the store's root.
  | { kind: "http"; url: string }
  // Files in a local folder picked with the File System Access API.
  | { kind: "directory"; handle: FileSystemDirectoryHandle };

export class HttpStore implements ZarrStore {
  // `url` is the URL of the store's root, without a trailing slash.
  constructor(public url: string) {}

  async get(key: string) {
    const url = `${this.url}/${key}`;
    const response = await fetch(url);
    // S3 answers 403 rather than 404 for a missing file.
    if (response.status === 404 || response.status === 403) return undefined;
    if (!response.ok) {
      throw new Error(
        `Fetching ${url} failed: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class DirectoryStore implements ZarrStore {
  constructor(public handle: FileSystemDirectoryHandle) {}

  async get(key: string) {
    const parts = key.split("/");
    const fileName = parts.pop()!;
    try {
      let directory = this.handle;
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part);
      }
      const fileHandle = await directory.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      // `TypeMismatchError`: a path component is a file where a folder is expected, or vice versa.
      if (
        e instanceof DOMException &&
        (e.name === "NotFoundError" || e.name === "TypeMismatchError")
      ) {
        return undefined;
      }
      throw e;
    }
  }
}

export function createZarrStore(spec: ZarrStoreSpec): ZarrStore {
  switch (spec.kind) {
    case "http":
      return new HttpStore(spec.url.replace(/\/+$/, ""));
    case "directory":
      return new DirectoryStore(spec.handle);
  }
}
