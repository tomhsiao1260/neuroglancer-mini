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

import type {
  CoordinateSpace,
} from "#src/state/coordinate_transform.js";
import {
  CoordinateSpaceCombiner,
  isLocalOrChannelDimension,
  isChannelDimension,
  isLocalDimension,
  TrackableCoordinateSpace,
} from "#src/state/coordinate_transform.js";
import type {
  DataSourceSpecification,
} from "#src/datasource/index.js";
import type { LoadedDataSubsource } from "#src/layer/layer_data_source.js";
import {
  LayerDataSource,
} from "#src/layer/layer_data_source.js";
import {
  Position,
} from '#src/state/navigation_state.js';
import type { RenderLayer } from "#src/render/renderlayer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { MessageList } from "#src/util/message_list.js";
import { NullarySignal } from "#src/util/signal.js";
import { DataType } from "#src/sliceview/volume/base.js";
import { MultiscaleVolumeChunkSource } from "#src/sliceview/volume/frontend.js";
import { ImageRenderLayer } from "#src/sliceview/volume/image_renderlayer.js";
import { WatchableValue } from "#src/state/trackable_value.js";

export class UserLayer extends RefCounted {
  localCoordinateSpace = new TrackableCoordinateSpace();
  localCoordinateSpaceCombiner = new CoordinateSpaceCombiner(
    this.localCoordinateSpace,
    () => true,
  );
  localPosition = this.registerDisposer(
    new Position(this.localCoordinateSpace),
  );

  static type: string;
  static typeAbbreviation: string;

  get type() {
    return (this.constructor as typeof UserLayer).type;
  }

  static supportsPickOption = false;

  messages = new MessageList();

  layersChanged = new NullarySignal();
  readyStateChanged = new NullarySignal();
  specificationChanged = new NullarySignal();
  renderLayers = new Array<RenderLayer>();

  dataSourcesChanged = new NullarySignal();
  dataSources: LayerDataSource[] = [];

  constructor(public manager: any) {
    super();
    this.localCoordinateSpaceCombiner.includeDimensionPredicate =
      isLocalOrChannelDimension;
    this.localPosition.changed.add(this.specificationChanged.dispatch);
    this.dataSourcesChanged.add(this.specificationChanged.dispatch);
    this.dataSourcesChanged.add(() => this.updateDataSubsourceActivations());
    this.messages.changed.add(this.layersChanged.dispatch);
    this.manager.coordinateSpaceCombiner = new CoordinateSpaceCombiner(
      this.manager.coordinateSpace,
      () => true,
    );
  }

  addDataSource(spec: DataSourceSpecification | undefined) {
    const layerDataSource = new LayerDataSource(this, spec);
    this.dataSources.push(layerDataSource);
    this.dataSourcesChanged.dispatch();
    return layerDataSource;
  }

  // Should be overridden by derived classes.
  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>): void {
    subsources;
  }

  updateDataSubsourceActivations() {
    function* getDataSubsources(
      this: UserLayer,
    ): Iterable<LoadedDataSubsource> {
      for (const dataSource of this.dataSources) {
        const { loadState } = dataSource;
        if (loadState === undefined || loadState.error !== undefined) continue;
        for (const subsource of loadState.subsources) {
          if (subsource.enabled) {
            yield subsource;
          } else {
            const { activated } = subsource;
            subsource.messages.clearMessages();
            if (activated !== undefined) {
              activated.dispose();
              subsource.activated = undefined;
              loadState.activatedSubsourcesChanged.dispatch();
            }
          }
        }
      }
    }
    this.activateDataSubsources(getDataSubsources.call(this));
  }

  addCoordinateSpace(
    coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    const globalBinding =
      this.manager.coordinateSpaceCombiner.bind(coordinateSpace);
    const localBinding =
      this.localCoordinateSpaceCombiner.bind(coordinateSpace);
    return () => {
      globalBinding();
      localBinding();
    };
  }

  getDataSourceSpecifications(layerSpec: any): DataSourceSpecification[] {
    const specs = []
    specs.push({
      enableDefaultSubsources: true,
      subsources: new Map(),
      transform: undefined,
      url:  "zarr2://http://localhost:9000/scroll.zarr/"
    })
    return specs;
  }

  restoreState(specification: any) {
    this.localCoordinateSpace.restoreState(
      specification[LOCAL_COORDINATE_SPACE_JSON_KEY],
    );
    this.localPosition.restoreState(specification[LOCAL_POSITION_JSON_KEY]);
    for (const spec of this.getDataSourceSpecifications(specification)) {
      this.addDataSource(spec);
    }
  }

  addRenderLayer(layer: Owned<RenderLayer>) {
    this.renderLayers.push(layer);
    const { layersChanged } = this;
    layer.layerChanged.add(layersChanged.dispatch);
    layer.userLayer = this;
    layersChanged.dispatch();
  }
}

export class ImageUserLayer extends UserLayer {
  layerChanged = new NullarySignal();

  *readyRenderLayers() {
    yield* this.renderLayers;
  }

  sliceViewRenderScaleTarget = new WatchableValue(1);
  channelCoordinateSpace = new TrackableCoordinateSpace();
  channelCoordinateSpaceCombiner = new CoordinateSpaceCombiner(
    this.channelCoordinateSpace,
    isChannelDimension,
  );

  markLoading() {
    const baseDisposer = super.markLoading?.();
    const channelDisposer = this.channelCoordinateSpaceCombiner.retain();
    return () => {
      baseDisposer?.();
      channelDisposer();
    };
  }

  addCoordinateSpace(
    coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    const baseBinding = super.addCoordinateSpace(coordinateSpace);
    const channelBinding =
      this.channelCoordinateSpaceCombiner.bind(coordinateSpace);
    return () => {
      baseBinding();
      channelBinding();
    };
  }

  constructor(manager: any) {
    super(manager);
    this.localCoordinateSpaceCombiner.includeDimensionPredicate =
      isLocalDimension;
    this.sliceViewRenderScaleTarget.changed.add(
      this.specificationChanged.dispatch,
    );
    this.layersChanged.add(this.layerChanged.dispatch),
    this.layerChanged.dispatch();
    this.restoreState({ type: "new", source: "" });
  }

  activateDataSubsources(subsources: Iterable<LoadedDataSubsource>) {
    let dataType: DataType | undefined;
    for (const loadedSubsource of subsources) {
      const { subsourceEntry } = loadedSubsource;
      const { subsource } = subsourceEntry;
      const { volume } = subsource;
      if (!(volume instanceof MultiscaleVolumeChunkSource)) {
        loadedSubsource.deactivate("Not compatible with image layer");
        continue;
      }
      if (dataType && volume.dataType !== dataType) {
        loadedSubsource.deactivate(
          `Data type must be ${DataType[volume.dataType].toLowerCase()}`,
        );
        continue;
      }
      dataType = volume.dataType;
      loadedSubsource.activate((context) => {
        loadedSubsource.addRenderLayer(
          new ImageRenderLayer(volume, {
            transform: loadedSubsource.getRenderLayerTransform(
              this.channelCoordinateSpace,
            ),
            renderScaleTarget: this.sliceViewRenderScaleTarget,
            localPosition: this.localPosition,
            channelCoordinateSpace: this.channelCoordinateSpace,
          }),
        );
      });
    }
  }

  restoreState(specification: any) {
    super.restoreState(specification);
    if (specification.sliceViewRenderScaleTarget !== undefined) {
      this.sliceViewRenderScaleTarget.value = specification.sliceViewRenderScaleTarget;
    }
    this.sliceViewRenderScaleTarget.changed.dispatch();
    this.channelCoordinateSpace.restoreState(
      specification[CHANNEL_DIMENSIONS_JSON_KEY],
    );
  }

  static type = "image";
  static typeAbbreviation = "img";
}

const LOCAL_POSITION_JSON_KEY = "localPosition";
const LOCAL_COORDINATE_SPACE_JSON_KEY = "localDimensions";
const CHANNEL_DIMENSIONS_JSON_KEY = "channelDimensions";
