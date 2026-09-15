/** @license Copyright 2019 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Requesting side of async computations (see `index.ts`).  Workers are launched as needed, up
 * to `maxWorkers`; a request goes to a free worker, or waits until one is free.
 */

import type { AsyncComputationSpec } from "#src/async_computation/index.js";

let numWorkers = 0;
const freeWorkers: Worker[] = [];
// Requests waiting for a free worker, by task id.
const pendingTasks = new Map<
  number,
  { msg: any; transfer: Transferable[] | undefined; cleanup?: () => void }
>();
// Requests not yet answered, by task id.
const tasks = new Map<
  number,
  {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }
>();
// On Safari, `navigator.hardwareConcurrency` is not defined.
const maxWorkers =
  typeof navigator.hardwareConcurrency === "undefined"
    ? 4
    : Math.min(12, navigator.hardwareConcurrency);
let nextTaskId = 0;

// Gives `worker` the oldest waiting request, or marks it as free.
function returnWorker(worker: Worker) {
  for (const [id, task] of pendingTasks) {
    pendingTasks.delete(id);
    task.cleanup?.();
    worker.postMessage(task.msg, task.transfer as Transferable[]);
    return;
  }
  freeWorkers.push(worker);
}

function launchWorker() {
  ++numWorkers;
  // Note: For compatibility with multiple bundlers, a browser-compatible URL
  // must be used with `new URL`, which means a Node.js subpath import like
  // "#src/worker/async_computation.bundle.js" cannot be used.
  const worker = new Worker(
    new URL("../worker/async_computation.bundle.js", import.meta.url),
    { type: "module" },
  );
  let ready = false;
  worker.onmessage = (msg) => {
    // First message indicates worker is ready.
    if (!ready) {
      ready = true;
      returnWorker(worker);
      return;
    }
    const { id, value, error } = msg.data as {
      id: number;
      value?: any;
      error?: string;
    };
    returnWorker(worker);
    const callbacks = tasks.get(id)!;
    tasks.delete(id);
    if (callbacks === undefined) return;
    if (error !== undefined) {
      callbacks.reject(error);
    } else {
      callbacks.resolve(value);
    }
  };
}

/**
 * Runs the computation `request` with `args` in a pool worker, transferring the objects in
 * `transfer`, and resolves to its result.  Aborting `signal` rejects the request if it is still
 * waiting for a worker; a computation that has started runs to completion.
 */
export function requestAsyncComputation<
  Signature extends (...args: any) => any,
>(
  request: AsyncComputationSpec<Signature>,
  signal: AbortSignal | undefined,
  transfer: Transferable[] | undefined,
  ...args: Parameters<Signature>
): Promise<ReturnType<Signature>> {
  const id = nextTaskId++;
  const msg = { t: request.id, id, args: args };

  signal?.throwIfAborted();

  const promise = new Promise<ReturnType<Signature>>((resolve, reject) => {
    tasks.set(id, { resolve, reject });
  });

  if (freeWorkers.length !== 0) {
    freeWorkers.pop()!.postMessage(msg, transfer as Transferable[]);
  } else {
    let cleanup: (() => void) | undefined;
    if (signal !== undefined) {
      function abortHandler() {
        pendingTasks.delete(id);
        const task = tasks.get(id)!;
        tasks.delete(id);
        task.reject(signal!.reason);
      }
      signal.addEventListener("abort", abortHandler, { once: true });
      cleanup = () => {
        signal.removeEventListener("abort", abortHandler);
      };
    }
    pendingTasks.set(id, { msg, transfer, cleanup });
    if (tasks.size > numWorkers && numWorkers < maxWorkers) {
      launchWorker();
    }
  }

  return promise;
}
