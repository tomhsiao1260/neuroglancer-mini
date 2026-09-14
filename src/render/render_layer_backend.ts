import type { ProjectionParameters } from "#src/render/projection_parameters.js";
import {
  PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID,
  PROJECTION_PARAMETERS_RPC_ID,
} from "#src/render/renderlayer.js";
import type {
  WatchableValueChangeInterface,
} from "#src/state/trackable_value.js";
import { Signal } from "#src/util/signal.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

@registerSharedObject(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParametersBackend<
    T extends ProjectionParameters = ProjectionParameters,
  >
  extends SharedObjectCounterpart
  implements WatchableValueChangeInterface<T>
{
  value: T;
  oldValue: T;
  changed = new Signal<(oldValue: T, newValue: T) => void>();
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.value = options.value;
    this.oldValue = Object.assign({}, this.value);
  }
}

registerRPC(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, function (x) {
  const obj: SharedProjectionParametersBackend = this.get(x.id);
  const { value, oldValue } = obj;
  Object.assign(oldValue, value);
  Object.assign(value, x.value);
  obj.changed.dispatch(oldValue, value);
});
