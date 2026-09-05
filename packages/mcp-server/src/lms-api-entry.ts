import { homedir } from "node:os";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { LmsApiRuntime, loadLmsConnections } from "./lms-api.js";
import { createLmsApiServer } from "./lms-api-server.js";
import { MOODLE_API_OPERATIONS } from "./moodle-api.js";
import { BLACKBOARD_API_OPERATIONS } from "./blackboard-api.js";

const connections = await loadLmsConnections(resolve(process.env.MORROW_LMS_CONNECTIONS_FILE || `${homedir()}/.morrow/lms-connections.json`));
const runtime = new LmsApiRuntime(connections, [...MOODLE_API_OPERATIONS, ...BLACKBOARD_API_OPERATIONS]);
await serveStdio(() => createLmsApiServer(runtime));
