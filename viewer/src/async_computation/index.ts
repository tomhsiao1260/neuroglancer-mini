/** @license Copyright 2019 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Computations run in a pool of separate workers, so that expensive work such as decompressing
 * chunks runs on several cores and does not block the chunk worker, which also schedules downloads.
 *
 * A computation is named by an `AsyncComputationSpec`, defined in a small module imported by both
 * sides: the code that requests it with `requestAsyncComputation` (`request.ts`), and the pool worker
 * that runs it, where it is registered with `registerAsyncComputation` (`handler.ts`).
 */

export interface AsyncComputationSpec<Signature extends (...args: any) => any> {
  id: string;
  t?: Signature;
}

export function asyncComputation<Signature extends (...args: any) => any>(
  id: string,
): AsyncComputationSpec<Signature> {
  return { id };
}
