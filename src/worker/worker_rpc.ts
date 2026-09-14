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
 * @file Messaging between the main thread and the chunk worker.
 *
 * `RPC.invoke(name, message)` posts `message` to the other side, where the handler registered with
 * `registerRPC(name, ...)` runs.
 *
 * A `SharedObject` exists on both sides under the same id: the owner (usually on the main thread)
 * calls `initializeCounterpart`, which creates the counterpart class registered with
 * `registerSharedObject` on the other side.  Either side can then look the object up with
 * `rpc.get(id)`.  The owner is disposed only once neither side holds a reference, which is tracked
 * with reference generations so that references sent while a release message is in flight are not
 * lost.
 */

import { RefCounted } from "#src/util/disposable.js";

export type RPCHandler = (this: RPC, x: any) => void;

export type RpcId = number;

const IS_WORKER = !(typeof Window !== "undefined" && self instanceof Window);

export const READY_ID = "rpc.ready";

const handlers = new Map<string, RPCHandler>();

export function registerRPC(key: string, handler: RPCHandler) {
  handlers.set(key, handler);
}

registerRPC(READY_ID, function (this: RPC, x: any) {
  x;
  this.onPeerReady();
});

interface RPCTarget {
  postMessage(message?: any, ports?: any): void;
  onmessage: ((ev: MessageEvent) => any) | null;
}

// Ids are allocated upward on the main thread and downward in the worker, so they never collide.
const INITIAL_RPC_ID = IS_WORKER ? -1 : 0;

export class RPC {
  private objects = new Map<RpcId, any>();
  private nextId: RpcId = INITIAL_RPC_ID;
  // Messages posted before the other side is ready, if waiting for it.
  private queue: { data: any; transfers?: any[] }[] | undefined;
  constructor(
    public target: RPCTarget,
    waitUntilReady: boolean,
  ) {
    if (waitUntilReady) {
      this.queue = [];
    }
    target.onmessage = (e) => {
      const data = e.data;
      handlers.get(data.functionName)!.call(this, data);
    };
  }

  sendReady() {
    this.invoke(READY_ID, {});
  }

  onPeerReady() {
    const { queue } = this;
    if (queue === undefined) return;
    this.queue = undefined;
    for (const { data, transfers } of queue) {
      this.target.postMessage(data, transfers);
    }
  }

  set(id: RpcId, value: any) {
    this.objects.set(id, value);
  }

  delete(id: RpcId) {
    this.objects.delete(id);
  }
  get(id: RpcId) {
    return this.objects.get(id);
  }

  // Returns the object referenced by `x` (from `SharedObject.addCounterpartRef`) and adds a
  // reference to it.
  getRef<T extends SharedObject>(x: { id: RpcId; gen: number }): T {
    const rpcId = x.id;
    const obj = <T>this.get(rpcId);
    obj.referencedGeneration = x.gen;
    obj.addRef();
    return obj;
  }

  invoke(name: string, x: any, transfers?: any[]) {
    x.functionName = name;
    const { queue } = this;
    if (queue !== undefined) {
      queue.push({ data: x, transfers });
      return;
    }
    this.target.postMessage(x, transfers);
  }

  newId() {
    return IS_WORKER ? this.nextId-- : this.nextId++;
  }
}

export class SharedObject extends RefCounted {
  rpc: RPC | null = null;
  rpcId: RpcId | null = null;
  isOwner: boolean | undefined;
  unreferencedGeneration: number;
  referencedGeneration: number;

  initializeSharedObject(rpc: RPC, rpcId = rpc.newId()) {
    this.rpc = rpc;
    this.rpcId = rpcId;
    this.isOwner = false;
    rpc.set(rpcId, this);
  }

  /**
   * Makes this object the owner of a new shared object, and creates the counterpart registered for
   * `RPC_TYPE_ID` on the other side with `options`.
   */
  initializeCounterpart(rpc: RPC, options: any = {}) {
    this.initializeSharedObject(rpc);
    this.unreferencedGeneration = 0;
    this.referencedGeneration = 0;
    this.isOwner = true;
    options.id = this.rpcId;
    options.type = this.RPC_TYPE_ID;
    rpc.invoke("SharedObject.new", options);
  }

  /**
   * Precondition: this.isOwner === true.
   */
  addCounterpartRef() {
    return { id: this.rpcId, gen: ++this.referencedGeneration };
  }

  protected refCountReachedZero() {
    if (this.isOwner === true) {
      if (this.referencedGeneration === this.unreferencedGeneration) {
        this.ownerDispose();
      }
    } else if (this.isOwner === false) {
      this.rpc!.invoke("SharedObject.refCountReachedZero", {
        id: this.rpcId,
        gen: this.referencedGeneration,
      });
    } else {
      super.refCountReachedZero();
    }
  }

  /**
   * Precondition: this.isOwner === true.
   */
  protected ownerDispose() {
    const { rpc, rpcId } = this;
    super.refCountReachedZero();
    rpc!.delete(rpcId!);
    rpc!.invoke("SharedObject.dispose", { id: rpcId });
  }

  /**
   * Precondition: this.isOwner === true.
   *
   * This should be called when the counterpart's refCount is decremented and reaches zero.
   */
  counterpartRefCountReachedZero(generation: number) {
    this.unreferencedGeneration = generation;
    if (this.refCount === 0 && generation === this.referencedGeneration) {
      this.ownerDispose();
    }
  }

  /**
   * Should be set to a constant specifying the SharedObject type identifier on the prototype of
   * final derived owner classes.  It is not used on counterpart (non-owner) classes.
   */
  RPC_TYPE_ID: string;
}

export function initializeSharedObjectCounterpart(
  obj: SharedObject,
  rpc?: RPC,
  options: any = {},
) {
  if (rpc != null) {
    obj.initializeSharedObject(rpc, options.id);
  }
}

/**
 * Base class for defining a SharedObject type that will never be owned.
 */
export class SharedObjectCounterpart extends SharedObject {
  constructor(rpc?: RPC, options: any = {}) {
    super();
    initializeSharedObjectCounterpart(this, rpc, options);
  }
}

export interface SharedObjectConstructor {
  new (rpc: RPC, options: any): SharedObjectCounterpart;
}

registerRPC("SharedObject.dispose", function (x) {
  const obj = <SharedObject>this.get(x.id);
  if (obj.refCount !== 0) {
    throw new Error(
      "Attempted to dispose object with non-zero reference count.",
    );
  }
  obj.disposed();
  this.delete(obj.rpcId!);
  obj.rpcId = null;
  obj.rpc = null;
});

registerRPC("SharedObject.refCountReachedZero", function (x) {
  const obj = <SharedObject>this.get(x.id);
  const generation = <number>x.gen;
  obj.counterpartRefCountReachedZero(generation);
});

const sharedObjectConstructors = new Map<string, SharedObjectConstructor>();

/**
 * Register a class as a SharedObject owner type under the specified identifier.
 *
 * This is intended to be used as a decorator.
 */
export function registerSharedObjectOwner(identifier: string) {
  return (constructorFunction: { prototype: { RPC_TYPE_ID: string } }) => {
    constructorFunction.prototype.RPC_TYPE_ID = identifier;
  };
}

/**
 * Register a class as a SharedObject counterpart type under the specified identifier.
 *
 * This is intended to be used as a decorator.
 *
 * Also register the type as a SharedObject owner, which is useful if this type is also used as a
 * SharedObject owner.
 */
export function registerSharedObject(identifier?: string) {
  return (constructorFunction: any) => {
    if (identifier !== undefined) {
      constructorFunction.prototype.RPC_TYPE_ID = identifier;
    } else {
      identifier = constructorFunction.prototype.RPC_TYPE_ID;
      if (identifier === undefined) {
        throw new Error("RPC_TYPE_ID should have already been defined");
      }
    }
    sharedObjectConstructors.set(identifier, constructorFunction);
  };
}

registerRPC("SharedObject.new", function (x) {
  const rpc = <RPC>this;
  const typeName = <string>x.type;
  const constructorFunction = sharedObjectConstructors.get(typeName)!;
  const obj = new constructorFunction(rpc, x);
  // Counterpart objects start with a reference count of zero.
  --obj.refCount;
});
