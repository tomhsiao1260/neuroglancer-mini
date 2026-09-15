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

/**
 * @file
 * Cancellation token system with similarity to the cancellation_token in Microsoft's PPL.
 */

/**
 * Interface used by cancelable operations to monitor whether cancellation has occurred.
 *
 * Note that this interface does not provide any way to trigger cancellation; for that,
 * CancellationTokenSource is used.
 */
export interface CancellationToken {
  /**
   * Indicates whether cancellation has occurred.
   */
  readonly isCanceled: boolean;

  /**
   * Add a cancellation handler function.  The handler will be invoked synchronously if
   * this.isCanceled === true.  Otherwise, it will be invoked synchronously upon cancellation,
   * unless it is removed prior to cancellation.
   *
   * The handler function must not throw any exceptions when called.
   *
   * @precondition The handler function must not already be registered.
   *
   * @param handler The handler function to add.
   *
   * @return A function that unregisters the handler.
   */
  add(handler: () => void): () => void;

  /**
   * Unregister a cancellation handler function.  If this.isCanceled, or the specified handler
   * function has not been registered, then this function has no effect.
   */
  remove(handler: () => void): void;
}

const noopFunction = () => {};

/**
 * Class that can be used to trigger cancellation.
 */
export class CancellationTokenSource implements CancellationToken {
  /**
   * Trigger cancellation.
   *
   * If this.isCanceled === false, then each registered cancellation handler is invoked
   * synchronously.
   */
  cancel() {
    const { handlers } = this;
    if (handlers !== null) {
      this.handlers = null;
      if (handlers !== undefined) {
        for (const handler of handlers) {
          handler();
        }
      }
    }
  }

  get isCanceled() {
    return this.handlers === null;
  }

  private handlers: Set<() => void> | undefined | null;

  add(handler: () => void) {
    let { handlers } = this;
    if (handlers === null) {
      handler();
      return noopFunction;
    }
    if (handlers === undefined) {
      handlers = this.handlers = new Set<() => void>();
    }
    handlers.add(handler);
    return () => {
      this.remove(handler);
    };
  }

  remove(handler: () => void) {
    const { handlers } = this;
    if (handlers != null) {
      handlers.delete(handler);
    }
  }
}
