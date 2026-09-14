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

import { debounce } from 'es-toolkit';
import { RenderViewport, renderViewportsEqual } from "#src/layer/display_context.js";
import type {
  DisplayDimensionRenderInfo,
  NavigationState,
} from "#src/state/navigation_state.js";
import {
  ProjectionParameters,
  projectionParametersEqual,
} from "#src/render/projection_parameters.js";
import type { WatchableValueChangeInterface } from "#src/state/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import { registerSharedObjectOwner, SharedObject } from "#src/worker/worker_rpc.js";

export const PROJECTION_PARAMETERS_RPC_ID = "SharedProjectionParameters";
export const PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID = "SharedProjectionParameters.changed";

export class RenderLayer extends RefCounted {
  layerChanged = new NullarySignal();
  redrawNeeded = new NullarySignal();
}

export class DerivedProjectionParameters<
    Parameters extends ProjectionParameters = ProjectionParameters,
  >
  extends RefCounted
  implements WatchableValueChangeInterface<Parameters>
{
  private oldValue_: Parameters;
  private value_: Parameters;
  private renderViewport = new RenderViewport();

  changed = new Signal<(oldValue: Parameters, newValue: Parameters) => void>();
  constructor(options: {
    navigationState: Borrowed<NavigationState>;
    update: (out: Parameters, navigationState: NavigationState) => void;
    isEqual?: (a: Parameters, b: Parameters) => boolean;
    parametersConstructor?: { new (): Parameters };
  }) {
    super();
    const {
      parametersConstructor = ProjectionParameters as { new (): Parameters },
      navigationState,
      update,
      isEqual = projectionParametersEqual,
    } = options;
    this.oldValue_ = new parametersConstructor();
    this.value_ = new parametersConstructor();
    const performUpdate = () => {
      const { oldValue_, value_ } = this;
      oldValue_.displayDimensionRenderInfo = navigationState.displayDimensionRenderInfo;
      Object.assign(oldValue_, this.renderViewport);
      let { globalPosition } = oldValue_;
      const newGlobalPosition = navigationState.position.value;
      const rank = newGlobalPosition.length;
      if (globalPosition.length !== rank) {
        oldValue_.globalPosition = globalPosition = new Float32Array(rank);
      }
      globalPosition.set(newGlobalPosition);
      update(oldValue_, navigationState);
      if (isEqual(oldValue_, value_)) return;
      this.value_ = oldValue_;
      this.oldValue_ = value_;
      this.changed.dispatch(value_, oldValue_);
    };
    const debouncedUpdate = (this.update = this.registerCancellable(
      debounce(performUpdate, 0),
    ));
    this.registerDisposer(navigationState.changed.add(debouncedUpdate));
    performUpdate();
  }

  setViewport(viewport: RenderViewport) {
    if (renderViewportsEqual(viewport, this.renderViewport)) return;
    Object.assign(this.renderViewport, viewport);
    this.update();
  }

  get value() {
    this.update.flush();
    return this.value_;
  }

  readonly update: (() => void) & { flush(): void };
}

@registerSharedObjectOwner(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParameters<
  T extends ProjectionParameters = ProjectionParameters,
> extends SharedObject {
  private prevDisplayDimensionRenderInfo:
    | undefined
    | DisplayDimensionRenderInfo = undefined;
  constructor(
    rpc: RPC,
    public base: WatchableValueChangeInterface<T>,
    public updateInterval = 10,
  ) {
    super();
    this.initializeCounterpart(rpc, { value: base.value });
    this.registerDisposer(base.changed.add(this.update));
  }

  flush() {
    this.update.flush();
  }

  private update = this.registerCancellable(
    debounce((_oldValue: T, newValue: T) => {
      // Note: Because we are using debouce, we cannot rely on `_oldValue`, since
      // `DerivedProjectionParameters` reuses the objects.
      let valueUpdate: any;
      if (
        newValue.displayDimensionRenderInfo !==
        this.prevDisplayDimensionRenderInfo
      ) {
        valueUpdate = newValue;
        this.prevDisplayDimensionRenderInfo =
          newValue.displayDimensionRenderInfo;
      } else {
        const { displayDimensionRenderInfo, ...remainder } = newValue;
        valueUpdate = remainder;
      }
      this.rpc!.invoke(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, {
        id: this.rpcId,
        value: valueUpdate,
      });
    }, this.updateInterval),
  );
}
