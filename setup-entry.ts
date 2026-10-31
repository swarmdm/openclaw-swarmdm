import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { swarmChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(swarmChannelPlugin);
