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
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type {
  CoordinateSpace,
  CoordinateSpaceTransform,
} from "#src/state/coordinate_transform.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import type { CancellationToken } from "#src/util/cancellation.js";
import { uncancelableToken } from "#src/util/cancellation.js";
import type {
  BasicCompletionResult,
  CompletionWithDescription,
} from "#src/util/completion.js";
import {
  getPrefixMatchesWithDescriptions,
} from "#src/util/completion.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { Trackable } from "#src/util/trackable.js";

export type CompletionResult = BasicCompletionResult<CompletionWithDescription>;

export class RedirectError extends Error {
  constructor(public redirectTarget: string) {
    super(`Redirected to: ${redirectTarget}`);
  }
}

/**
 * Returns the length of the prefix of path that corresponds to the "group", according to the
 * specified separator.
 *
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function findSourceGroupBasedOnSeparator(
  path: string,
  separator?: string,
) {
  if (separator === undefined) {
    // Try to guess whether '/' or ':' is the separator.
    if (path.indexOf("/") === -1) {
      separator = ":";
    } else {
      separator = "/";
    }
  }
  const index = path.lastIndexOf(separator);
  if (index === -1) {
    return 0;
  }
  return index + 1;
}

/**
 * Returns the last "component" of path, according to the specified separator.
 * If the separator is not specified, gueses whether it is '/' or ':'.
 */
export function suggestLayerNameBasedOnSeparator(
  path: string,
  separator?: string,
) {
  const groupIndex = findSourceGroupBasedOnSeparator(path, separator);
  return path.substring(groupIndex);
}

export interface GetDataSourceOptionsBase {
  chunkManager: ChunkManager;
  cancellationToken?: CancellationToken;
  url: string;
  globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>;
  state?: any;
}

export interface GetDataSourceOptions extends GetDataSourceOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  cancellationToken: CancellationToken;
  providerProtocol: string;
}

export interface ConvertLegacyUrlOptionsBase {
  url: string;
  type: "mesh" | "skeletons" | "single_mesh";
}

export interface ConvertLegacyUrlOptions extends ConvertLegacyUrlOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  providerProtocol: string;
}

export interface NormalizeUrlOptionsBase {
  url: string;
}

export interface NormalizeUrlOptions extends NormalizeUrlOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  providerProtocol: string;
}

export enum LocalDataSource {
  annotations = 0,
  equivalences = 1,
}

export interface CompleteUrlOptionsBase {
  url: string;
  cancellationToken?: CancellationToken;
  chunkManager: ChunkManager;
}

export interface CompleteUrlOptions extends CompleteUrlOptionsBase {
  registry: DataSourceProviderRegistry;
  providerUrl: string;
  cancellationToken: CancellationToken;
}

export interface DataSubsourceEntry {
  /**
   * Unique identifier (within the group) for this subsource.  Stored in the JSON state
   * representation to indicate which subsources are enabled.  The empty string `""` should be used
   * for the first/primary subsource.
   */
  id: string;

  /**
   * Homoegeneous transformation from the subsource to the model subspace corresponding to
   * `modelSubspceDimensionIndices`.  The rank is equal to the length of
   * `modelSubspaceDimensionIndices`.  If this is greater than the subsource rank, the subsource
   * coordinate space is implicitly padded at the end with additional dummy dimensions with a range
   * of `[0, 1]`.  If unspecified, defaults to the identity transform.
   */
  subsourceToModelSubspaceTransform?: Float32Array;

  /**
   * Specifies the model dimensions corresponding to this subsource.  If unspecified, defaults to
   * `[0, ..., modelSpace.rank)`.
   */
  modelSubspaceDimensionIndices?: number[];

  /**
   * Specifies whether this associated data source is enabled by default.
   */
  default: boolean;
}

export interface DataSource {
  subsources: DataSubsourceEntry[];
  modelTransform: CoordinateSpaceTransform;
  canChangeModelSpaceRank?: boolean;
  state?: Trackable;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface DataSourceProvider {
  /**
   * Returns a suggested layer name for the given volume source.
   */
  suggestLayerName?(path: string): string;

  /**
   * Returns the length of the prefix of path that is its 'group'.  This is used for suggesting a
   * default URL for adding a new layer.
   */
  findSourceGroup?(path: string): number;
}

export interface DataSubsourceSpecification {
  enabled?: boolean;
}

export interface DataSourceSpecification {
  url: string;
  enableDefaultSubsources: boolean;
  subsources: Map<string, DataSubsourceSpecification>;
  state?: any;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export abstract class DataSourceProvider extends RefCounted {
  abstract description?: string;

  abstract get(options: GetDataSourceOptions): Promise<DataSource>;

  normalizeUrl(options: NormalizeUrlOptions): string {
    return options.url;
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptions): string {
    return options.url;
  }
}

export const localAnnotationsUrl = "local://annotations";
export const localEquivalencesUrl = "local://equivalences";

class LocalDataSourceProvider extends DataSourceProvider {
  get description() {
    return "Local in-memory";
  }
}

const protocolPattern = /^(?:([a-zA-Z][a-zA-Z0-9-+_]*):\/\/)?(.*)$/;

export class DataSourceProviderRegistry extends RefCounted {
  constructor() {
    super();
  }
  dataSources = new Map<string, Owned<DataSourceProvider>>([
    ["local", new LocalDataSourceProvider()],
  ]);

  register(name: string, dataSource: Owned<DataSourceProvider>) {
    this.dataSources.set(name, this.registerDisposer(dataSource));
  }

  getProvider(url: string): [DataSourceProvider, string, string] {
    const m = url.match(protocolPattern);
    if (m === null || m[1] === undefined) {
      throw new Error(
        `Data source URL must have the form "<protocol>://<path>".`,
      );
    }
    const [, providerProtocol, providerUrl] = m;
    const factory = this.dataSources.get(providerProtocol);
    if (factory === undefined) {
      throw new Error(
        `Unsupported data source: ${JSON.stringify(providerProtocol)}.`,
      );
    }
    return [factory, providerUrl, providerProtocol];
  }

  // async get(options: GetDataSourceOptionsBase): Promise<number> {
  async get(options: GetDataSourceOptionsBase): Promise<DataSource> {
    const redirectLog = new Set<string>();
    const { cancellationToken = uncancelableToken } = options;
    let url: string = options.url;
    while (true) {
      const [provider, providerUrl, providerProtocol] = this.getProvider(
        options.url,
      );
      try {
        return provider.get({
          ...options,
          url,
          providerProtocol,
          providerUrl,
          registry: this,
          cancellationToken,
        });
      } catch (e) {
        if (e instanceof RedirectError) {
          const redirect = e.redirectTarget;
          if (redirectLog.has(redirect)) {
            throw Error(
              `Layer source redirection contains loop: ${JSON.stringify(
                Array.from(redirectLog),
              )}`,
            );
          }
          if (redirectLog.size >= 10) {
            throw Error(
              `Too many layer source redirections: ${JSON.stringify(
                Array.from(redirectLog),
              )}`,
            );
          }
          url = redirect;
          continue;
        }
        throw e;
      }
    }
  }

  convertLegacyUrl(options: ConvertLegacyUrlOptionsBase): string {
    try {
      const [provider, providerUrl, providerProtocol] = this.getProvider(
        options.url,
      );
      return provider.convertLegacyUrl({
        ...options,
        providerUrl,
        providerProtocol,
        registry: this,
      });
    } catch {
      return options.url;
    }
  }

  normalizeUrl(options: NormalizeUrlOptionsBase): string {
    try {
      const [provider, providerUrl, providerProtocol] = this.getProvider(
        options.url,
      );
      return provider.normalizeUrl({
        ...options,
        providerUrl,
        providerProtocol,
        registry: this,
      });
    } catch {
      return options.url;
    }
  }

  async completeUrl(
    options: CompleteUrlOptionsBase,
  ): Promise<CompletionResult> {
    // Check if url matches a protocol.  Note that protocolPattern always matches.
    const { url } = options;
    const protocolMatch = url.match(protocolPattern)!;
    const protocol = protocolMatch[1];
    if (protocol === undefined) {
      return Promise.resolve({
        offset: 0,
        completions: getPrefixMatchesWithDescriptions(
          url,
          this.dataSources,
          ([name]) => `${name}://`,
          ([, factory]) => factory.description,
        ),
      });
    }
    throw null;
  }

  suggestLayerName(url: string) {
    let [dataSource, path] = this.getProvider(url);
    if (path.endsWith("/")) {
      path = path.substring(0, path.length - 1);
    }
    const suggestor = dataSource.suggestLayerName;
    if (suggestor !== undefined) {
      return suggestor(path);
    }
    return suggestLayerNameBasedOnSeparator(path);
  }

  findSourceGroup(url: string) {
    const [dataSource, path, dataSourceName] = this.getProvider(url);
    const helper =
      dataSource.findSourceGroup || findSourceGroupBasedOnSeparator;
    return helper(path) + dataSourceName.length + 3;
  }
}
