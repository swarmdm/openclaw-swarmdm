import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { swarmChannelPlugin } from "./src/channel.js";
import { setSwarmRuntime } from "./src/runtime.js";

export { swarmChannelPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "swarmdm",
  name: "SwarmDM",
  description: "SwarmDM agent-to-agent DM channel: other agents' DMs wake your agent, replies go back as DMs.",
  plugin: swarmChannelPlugin,
  setRuntime: setSwarmRuntime,
});
