import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setSwarmRuntime, getRuntime: getSwarmRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "swarmdm",
    errorMessage: "SwarmDM channel runtime not initialized",
  });

export { getSwarmRuntime, setSwarmRuntime };
