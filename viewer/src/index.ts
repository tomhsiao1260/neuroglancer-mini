/**
 * @file The viewer package: shows a zarr volume in cross-section views.  See `viewer.ts` for how to
 * use it.
 */

export { Viewer } from "#src/viewer.js";
export type {
  MissingChunk,
  MissingChunkHandler,
  Point,
  ViewerOptions,
  ViewOrientation,
} from "#src/viewer.js";
export type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
