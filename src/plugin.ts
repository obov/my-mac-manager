// Public module for plugin authors: import { definePlugin } from "my-mac-manager/plugin"
import type { Plugin } from "./types.js";
export type * from "./types.js";

/** Identity function for type inference. Exporting the plain object works the same */
export function definePlugin<T extends Plugin>(p: T): T {
  return p;
}
