/** @license Copyright 2022 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import {
  parseArray,
  parseFixedLengthArray,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";
import * as matrix from "#src/util/matrix.js";

export interface OmeMultiscaleScale {
  // Path of the scale's array within the store, e.g. `0`.
  path: string;
  transform: Float64Array;
}

export interface OmeMultiscaleMetadata {
  // Number of axes.
  rank: number;
  scales: OmeMultiscaleScale[];
}

const SUPPORTED_OME_MULTISCALE_VERSIONS = new Set(["0.4", "0.5-dev"]);

// The axes the viewer shows, in the order zarr lists them.
const AXIS_NAMES = ["z", "y", "x"];

/**
 * Checks that the volume has the three spatial axes the viewer shows, and returns their number.
 *
 * The viewer works in voxels rather than physical units, so the scale and unit of each axis are not
 * needed; but it does show the axes in a fixed order, so a volume with other axes (a time or channel
 * axis, say) is rejected here rather than displayed with its axes mixed up.
 */
function parseOmeAxes(axes: unknown): number {
  const names = parseArray(axes, (axis) =>
    verifyObjectProperty(verifyObject(axis), "name", verifyString),
  );
  if (
    names.length !== AXIS_NAMES.length ||
    names.some((name, i) => name !== AXIS_NAMES[i])
  ) {
    throw new Error(
      `Expected axes (${AXIS_NAMES.join(", ")}), but received: (${names.join(", ")})`,
    );
  }
  return names.length;
}

function parseScaleTransform(rank: number, obj: unknown) {
  const scales = verifyObjectProperty(obj, "scale", (values) =>
    parseFixedLengthArray(
      new Float64Array(rank),
      values,
      verifyFinitePositiveFloat,
    ),
  );
  return matrix.createHomogeneousScaleMatrix(Float64Array, scales);
}

function parseIdentityTransform(rank: number, obj: unknown) {
  obj;
  return matrix.createIdentity(Float64Array, rank + 1);
}

function parseTranslationTransform(rank: number, obj: unknown) {
  const translation = verifyObjectProperty(obj, "translation", (values) =>
    parseFixedLengthArray(new Float64Array(rank), values, verifyFiniteFloat),
  );
  return matrix.createHomogeneousTranslationMatrix(Float64Array, translation);
}

const coordinateTransformParsers = new Map([
  ["scale", parseScaleTransform],
  ["identity", parseIdentityTransform],
  ["translation", parseTranslationTransform],
]);

function parseOmeCoordinateTransform(
  rank: number,
  transformJson: unknown,
): Float64Array {
  verifyObject(transformJson);
  const transformType = verifyObjectProperty(
    transformJson,
    "type",
    verifyString,
  );
  const parser = coordinateTransformParsers.get(transformType);
  if (parser === undefined) {
    throw new Error(
      `Unsupported coordinate transform type: ${JSON.stringify(transformType)}`,
    );
  }
  return parser(rank, transformJson);
}

function parseOmeCoordinateTransforms(
  rank: number,
  transforms: unknown,
): Float64Array {
  let transform = matrix.createIdentity(Float64Array, rank + 1);
  if (transforms === undefined) return transform;
  parseArray(transforms, (transformJson) => {
    const newTransform = parseOmeCoordinateTransform(rank, transformJson);
    transform = matrix.multiply(
      new Float64Array(transform.length),
      rank + 1,
      newTransform,
      rank + 1,
      transform,
      rank + 1,
      rank + 1,
      rank + 1,
      rank + 1,
    );
  });
  return transform;
}

function parseMultiscaleScale(rank: number, obj: unknown): OmeMultiscaleScale {
  const path = verifyObjectProperty(obj, "path", verifyString);
  const transform = verifyObjectProperty(
    obj,
    "coordinateTransformations",
    (x) => parseOmeCoordinateTransforms(rank, x),
  );
  return { path, transform };
}

function parseOmeMultiscale(multiscale: unknown): OmeMultiscaleMetadata {
  const rank = verifyObjectProperty(multiscale, "axes", parseOmeAxes);
  const transform = verifyObjectProperty(
    multiscale,
    "coordinateTransformations",
    (x) => parseOmeCoordinateTransforms(rank, x),
  );
  const scales = verifyObjectProperty(multiscale, "datasets", (obj) =>
    parseArray(obj, (x) => {
      const scale = parseMultiscaleScale(rank, x);
      scale.transform = matrix.multiply(
        new Float64Array((rank + 1) ** 2),
        rank + 1,
        transform,
        rank + 1,
        scale.transform,
        rank + 1,
        rank + 1,
        rank + 1,
        rank + 1,
      );
      return scale;
    }),
  );
  if (scales.length === 0) {
    throw new Error("At least one scale must be specified");
  }

  const baseTransform = scales[0].transform;
  // Extract the scale factor from `baseTransform`.  Only `scale`, `identity` and `translation`
  // transforms are supported, so every transform here is a diagonal matrix with a translation, and
  // the scale factor of a dimension is the diagonal entry.
  const baseScales = new Float64Array(rank);
  for (let i = 0; i < rank; ++i) {
    baseScales[i] = baseTransform[i * (rank + 1) + i];
  }

  for (const scale of scales) {
    const t = scale.transform;
    // In OME's coordinate space, the origin of a voxel is its center, while in Neuroglancer it is
    // the "lower" (in coordinates) corner.  Translate by the physical size of half a voxel in the
    // current scale.
    for (let i = 0; i < rank; ++i) {
      let offset = 0;
      for (let j = 0; j < rank; ++j) {
        offset += t[j * (rank + 1) + i] * 0.5;
      }
      t[rank * (rank + 1) + i] -= offset;
    }

    // Make the scale relative to the base scale.
    for (let i = 0; i < rank; ++i) {
      for (let j = 0; j <= rank; ++j) {
        t[j * (rank + 1) + i] /= baseScales[i];
      }
    }
  }
  return { rank, scales };
}

/**
 * Returns the multiscale volume described by the OME metadata of a `.zattrs` file.  A `.zattrs` file
 * may describe several multiscale volumes; the viewer shows the first one.
 */
export function parseOmeMetadata(attrs: any): OmeMultiscaleMetadata {
  if (attrs.multiscales === undefined) {
    throw new Error(
      "No OME multiscale metadata found: `.zattrs` has no `multiscales` property",
    );
  }
  const multiscale = verifyObjectProperty(attrs, "multiscales", (value) => {
    const multiscales = parseArray(value, verifyObject);
    if (multiscales.length === 0) {
      throw new Error("At least one multiscale volume must be specified");
    }
    return multiscales[0];
  });
  const version = verifyObjectProperty(multiscale, "version", verifyString);
  if (!SUPPORTED_OME_MULTISCALE_VERSIONS.has(version)) {
    throw new Error(
      `OME multiscale metadata version ${JSON.stringify(
        version,
      )} is not supported`,
    );
  }
  return parseOmeMultiscale(multiscale);
}
