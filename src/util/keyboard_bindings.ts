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
 * @file Facility for triggering named actions in response to keyboard events.
 */

// This is based on goog/ui/keyboardshortcuthandler.js in the Google Closure library.

import { WatchableValue } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import type {
  ActionEvent,
  EventActionMapInterface,
} from "#src/util/event_action_map.js";
import {
  dispatchEventWithModifiers,
  EventActionMap,
  registerActionListener,
  getEventModifierMask,
} from "#src/util/event_action_map.js";

export const globalModifiers = new WatchableValue<number>(0);
window.addEventListener("keydown", (event) => {
  globalModifiers.value = getEventModifierMask(event);
});
window.addEventListener("keyup", (event) => {
  globalModifiers.value = getEventModifierMask(event);
});

const globalKeys = new Set([
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "escape",
  "pause",
]);
const DEFAULT_TEXT_INPUTS = new Set([
  "color",
  "date",
  "datetime",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);

export function getEventKeyName(event: KeyboardEvent): string {
  return event.code.toLowerCase();
}

export { EventActionMap, registerActionListener };
export type { EventActionMapInterface, ActionEvent };
