import type { SceneSpec } from "@ai-archviz/scene-spec";

/**
 * A renderer adapter compiles renderer-neutral SceneSpec intent into trusted,
 * structured execution data. Compilation is deliberately free of DCC, file
 * system, plugin-discovery, and process concerns.
 */
export interface RendererAdapter<TPlan> {
  readonly engine: string;

  compile(sceneSpec: SceneSpec, renderJob: unknown): TPlan;
}
