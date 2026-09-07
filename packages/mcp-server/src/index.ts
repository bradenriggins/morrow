#!/usr/bin/env node
import { loadGatewayConfig } from "./config.js";
import { runLocalOwner, runLocalOwnerProxy } from "./local-owner.js";

const config = await loadGatewayConfig();
if (process.argv.includes("--morrow-local-owner")) await runLocalOwner(config);
else await runLocalOwnerProxy(config);
