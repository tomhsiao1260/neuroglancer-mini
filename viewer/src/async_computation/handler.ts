/** @license Copyright 2019 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Pool worker side of async computations (see `index.ts`): runs the computations registered
 * with `registerAsyncComputation` and posts back their results.
 */

import type { AsyncComputationSpec } from "#src/async_computation/index.js";

const handlers = new Map<
  string,
  (...args: any[]) => Promise<{ value: any; transfer?: Transferable[] }>
>();

// The worker's global scope (`DedicatedWorkerGlobalScope`), reduced to what is used here.
interface MessagePort {
  postMessage(message: any, options?: { transfer?: Transferable[] }): void;
}

function setupChannel(port: MessagePort) {
  self.onmessage = async (msg: any) => {
    const { t, id, args } = msg.data as { t: string; id: number; args: any[] };
    try {
      const handler = handlers.get(t)!;
      if (handler === undefined) {
        throw new Error(
          `Internal error: async computation operation ${JSON.stringify(t)} is not registered.  Registered handlers: ${JSON.stringify(Array.from(handlers.keys()))}`,
        );
      }
      const { value, transfer } = await handler(...args);
      port.postMessage({ id, value }, { transfer });
    } catch (error) {
      port.postMessage({
        id,
        error,
      });
    }
  };
  // Notify that the worker is ready to receive messages.
  self.postMessage(null);
}

setupChannel(self as unknown as MessagePort);

export function registerAsyncComputation<
  Signature extends (...args: any) => any,
>(
  request: AsyncComputationSpec<Signature>,
  handler: (
    ...args: Parameters<Signature>
  ) => Promise<{ value: ReturnType<Signature>; transfer?: Transferable[] }>,
) {
  handlers.set(request.id, handler);
}
