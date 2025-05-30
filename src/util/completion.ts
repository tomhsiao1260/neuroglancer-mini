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

import { defaultStringCompare } from "#src/util/string.js";

export interface Completion {
  value: string;
}

export interface CompletionWithDescription extends Completion {
  description?: string;
}

export interface BasicCompletionResult<C extends Completion = Completion> {
  completions: C[];
  offset: number;
}

export const emptyCompletionResult = {
  offset: 0,
  completions: [],
};

export function getPrefixMatches(prefix: string, options: Iterable<string>) {
  const result: Completion[] = [];
  for (const option of options) {
    if (option.startsWith(prefix)) {
      result.push({ value: option });
    }
  }
  result.sort((a, b) => defaultStringCompare(a.value, b.value));
  return result;
}

export function getPrefixMatchesWithDescriptions<T>(
  prefix: string,
  options: Iterable<T>,
  getValue: (x: T) => string,
  getDescription: (x: T) => string | undefined,
) {
  const result: CompletionWithDescription[] = [];
  for (const option of options) {
    const key = getValue(option);
    if (key.startsWith(prefix)) {
      result.push({ value: key, description: getDescription(option) });
    }
  }
  result.sort((a, b) => defaultStringCompare(a.value, b.value));
  return result;
}

export interface QueryStringCompletionTableEntry<
  C extends Completion = Completion,
> {
  readonly key: C;
  readonly values: readonly C[];
}

export type QueryStringCompletionTable<C extends Completion = Completion> =
  readonly QueryStringCompletionTableEntry<C>[];

export async function completeQueryStringParametersFromTable<
  C extends Completion,
>(queryString: string, table: QueryStringCompletionTable<C>) {
  return completeQueryStringParameters(
    queryString,
    async (key) => {
      const results: C[] = [];
      for (const entry of table) {
        const keyEntry = entry.key;
        if (keyEntry.value.startsWith(key)) results.push(keyEntry);
      }
      return { offset: 0, completions: results };
    },
    async (key, value) => {
      for (const entry of table) {
        if (entry.key.value !== key) continue;
        return {
          offset: 0,
          completions: entry.values.filter((x) => x.value.startsWith(value)),
        };
      }
      return emptyCompletionResult;
    },
  );
}
