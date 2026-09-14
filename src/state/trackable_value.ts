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

import { RefCounted } from "#src/util/disposable.js";
import type { NullaryReadonlySignal } from "#src/util/signal.js";
import { neverSignal, NullarySignal, Signal } from "#src/util/signal.js";

export interface WatchableValueInterface<T> {
  value: T;
  changed: NullaryReadonlySignal;
}

export interface WatchableValueChangeInterface<T> {
  readonly value: T;
  readonly changed: Signal<(oldValue: T, newValue: T) => void>;
}

export class WatchableValue<T> implements WatchableValueInterface<T> {
  get value() {
    return this.value_;
  }
  set value(newValue: T) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();
  constructor(protected value_: T) {}
}


export function constantWatchableValue<T>(
  value: T,
): WatchableValueInterface<T> {
  return { changed: neverSignal, value };
}


