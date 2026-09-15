/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Simple signal dispatch mechanism.
 */

/**
 * This class provides a simple signal dispatch mechanism.  Handlers can be added, and then the
 * `dispatch` method calls all of them.
 *
 * If specified, Callable should be an interface containing only a callable signature returning
 * void.  Due to limitations in TypeScript, any interface containing a callable signature will be
 * accepted by the compiler, but the resultant signature of `dispatch` will not be correct.
 */
export class Signal<Callable extends Function = () => void> {
  private handlers = new Set<Callable>();

  constructor() {
    const obj = this;
    this.dispatch = <Callable>(<Function>function (this: any) {
      obj.handlers.forEach((handler) => {
        // eslint-disable-next-line prefer-rest-params
        handler.apply(this, arguments);
      });
    });
  }

  /**
   * Add a handler function.  If `dispatch` is currently be called, then the new handler will be
   * called before `dispatch` returns.
   *
   * @param handler The handler function to add.
   *
   * @return A function that unregisters the handler.
   */
  add(handler: Callable): () => boolean {
    this.handlers.add(handler);
    return () => {
      return this.remove(handler);
    };
  }

  /**
   * Remove a handler function.  If `dispatch` is currently be called and the new handler has not
   * yet been called, then it will not be called.
   *
   * @param handler Handler to remove.
   * @return `true` if the handler was present, `false` otherwise.
   */
  remove(handler: Callable): boolean {
    return this.handlers.delete(handler);
  }

  /**
   * Invokes each handler function with the same parameters (including `this`) with which it is
   * called.  Handlers are invoked in the order in which they were added.
   */
  dispatch: Callable;

  /**
   * Disposes of resources.  No methods, including `dispatch`, may be invoked afterwards.
   */
  dispose() {
    this.handlers = <any>undefined;
  }
}

/**
 * Simple specialization of Signal for the common case of a nullary handler signature.
 */
export class NullarySignal extends Signal<() => void> {}
