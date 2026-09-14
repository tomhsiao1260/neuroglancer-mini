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


