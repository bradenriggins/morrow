import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { isJsonObject, type JsonObject } from "@morrow/contracts";
import { parseGatewayConfig } from "../src/config.js";
import { MorrowRuntime } from "../src/morrow-runtime.js";
import { bridgeCatalogDigestForTests } from "./fixtures/bridge-catalog-digest.js";
import { connectBridgeTestClient, type BridgeTestClient } from "./fixtures/bridge-client.js";
import { assertPortListening, reserveLoopbackPort } from "./fixtures/loopback-port.js";
/**
 * The deadline for one case, and for the fixture a group of cases shares. Every
 * case here drives a real connector process over a real loopback bridge; the
 * slowest one measured under a second of work on this machine, and the fixture
 * that starts the connector measured about four. Change the deadline here, not
 * per case.
 */
const CASE_TIMEOUT_MS = 30000;
function operationId(result: JsonObject): string {
    const value = isJsonObject(result.structuredContent) ? result.structuredContent.operationId : undefined;
    if (typeof value !== "string")
        throw new Error("operation id missing");
    return value;
}
function connectorConfig(directory: string, port: number) {
    const root = resolve("../..");
    const catalogPath = resolve(root, "artifacts/canvas-api/canvas-api-catalog.json");
    return parseGatewayConfig({
        schema: "morrow.upstreams.v1",
        profile: "private-full",
        upstreams: [{
                id: "canvas-session",
                label: "Morrow Canvas Connector",
                kind: "mcp-stdio",
                command: process.execPath,
                args: [resolve(root, "packages/canvas-connector-mcp/dist/index.js")],
                cwd: root,
                env: {
                    MORROW_CANVAS_CATALOG_PATH: catalogPath,
                    MORROW_CANVAS_CONNECTOR_STATE: join(directory, "connector.json"),
                    MORROW_CANVAS_CONNECTOR_PORT: String(port),
                    MORROW_CANVAS_CONNECTOR_TOKEN: "gateway-connector-secret-".repeat(3),
                    MORROW_CANVAS_CONNECTOR_EXTENSION_IDS: "a".repeat(32),
                },
                sourceDisposition: "adapted_owned",
                outputPrivacy: {},
                outputPrivacyDefault: {
                    allowedFields: [],
                    fieldPolicy: "scrub-sensitive",
                    dataClass: "course",
                    maxRecords: 10000,
                    maxBytes: 2000000,
                    freeText: "allow",
                    learnerTokens: true,
                    artifactInspection: "deny",
                    aiClientAdmission: "allow",
                },
            }],
        filters: { excludePrefixes: [], excludeNames: [] },
        operationJournal: { path: join(directory, "gateway.sqlite3") },
        privacy: { canvasOrigin: "browser-session", account: "local", principal: "local", learnerVaultPath: join(directory, "vault.json") },
        maxCatalogTools: 2000,
    });
}
it("a fresh handshake preserves course authority, but a new connection identity invalidates old approval and the journal refuses replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "morrow-review-scope-"));
    const port = await reserveLoopbackPort();
    const catalogDigest = bridgeCatalogDigestForTests(resolve("../.."));
    const binding = { sourceBindingId: "canvas:057e6e2c0017998759e2:g1:c42", provider: "canvas" as const, origin: "https://school.instructure.com", courseId: "42", principalFingerprint: "c".repeat(64), sessionGeneration: 1, catalogDigest, runtimeVerified: true, editOptionsAvailable: true, editPolicyRevision: 0 };
    const morrow = await MorrowRuntime.connect(connectorConfig(directory, port), { statePath: join(directory, "gateway.sqlite3") });
    const runtime = morrow.gateway;
    let bridge: BridgeTestClient | undefined;
    let writes = 0;
    const connect = async () => {
        await assertPortListening(port);
        const client = await connectBridgeTestClient({ port, token: "gateway-connector-secret-".repeat(3), extensionId: "a".repeat(32), catalogDigest, bindings: [binding] });
        client.onCommand(command => {
            if (command.kind === "invoke_write")
                writes++;
            client.respond(command, command.kind === "edit_policy_options_get" ? { schema: "morrow.bridge.edit-options.v1", sourceBindingId: binding.sourceBindingId, provider: "canvas", catalogDigest, policyRevision: 0, runtimeVerified: true, options: [] } : { schema: "morrow.canvas-browser-result.v1", ok: true, sent: true, status: 200, truncated: false, data: { hide_final_grades: true } });
        });
        return client;
    };
    try {
        bridge = await connect();
        await new Promise(r => setTimeout(r, 30));
        const planned = await runtime.call("canvas_update_course_settings", { course_id: "42", hide_final_grades: true, _morrow: { operation_id: "review-reconnect-staged", source_binding_id: binding.sourceBindingId } });
        const id = operationId(planned);
        runtime.approveOperation(id);
        await bridge.close();
        bridge = await connect();
        await new Promise(r => setTimeout(r, 30));
        await runtime.dispatchOperation(id);
        expect(writes).toBe(1); // A socket handshake alone does not invalidate a still-identical course authority.
        const repeat = await runtime.dispatchOperation(id);
        expect(repeat.isError).toBe(true);
        expect(writes).toBe(1);
        const staged = await runtime.call("canvas_update_course_settings", { course_id: "42", hide_final_grades: false, _morrow: { operation_id: "review-disconnect-identity", source_binding_id: binding.sourceBindingId } });
        const staleId = operationId(staged);
        runtime.approveOperation(staleId);
        bridge.updateBindings([{ ...binding, sourceBindingId: binding.sourceBindingId + ":new-connection" }]);
        await new Promise(r => setTimeout(r, 30));
        const refused = await runtime.dispatchOperation(staleId);
        expect(refused.isError).toBe(true);
        expect(writes).toBe(1);
        expect(runtime.effects.get(staleId)).toMatchObject({ state: "approved", dispatchAttempt: 0 });
        expect(JSON.stringify(refused)).not.toContain("provider_effect_target_conflict");
        // Distinguish connection refusal from the still-unconfirmed first write's target barrier.
        bridge.updateBindings([binding]);
        await new Promise(r => setTimeout(r, 30));
        expect(JSON.stringify(await runtime.dispatchOperation(staleId))).toContain("provider_effect_target_conflict");
        const newConnection = { ...binding, sourceBindingId: binding.sourceBindingId + ":nonce-uncertain-check" };
        bridge.updateBindings([newConnection]);
        await new Promise(r => setTimeout(r, 30));
        const rebound = await runtime.call("canvas_update_course_settings", { course_id: "42", hide_final_grades: false, _morrow: { operation_id: "review-new-connection-unknown-target", source_binding_id: newConnection.sourceBindingId } });
        expect(rebound.isError, JSON.stringify(rebound)).not.toBe(true);
        const reboundId = operationId(rebound);
        runtime.approveOperation(reboundId);
        const blocked = await runtime.dispatchOperation(reboundId);
        expect(JSON.stringify(blocked)).toContain("provider_effect_target_conflict");
        expect(writes).toBe(1);
        bridge.updateBindings([binding]);
        await new Promise(r => setTimeout(r, 30));
        for (const [index, changed] of [
            { ...binding, principalFingerprint: "e".repeat(64) },
            { ...binding, sessionGeneration: 2 },
            { ...binding, courseId: "43" },
            { ...binding, origin: "https://other.instructure.com" },
            { ...binding, provider: "moodle" as const, siteUrl: "https://school.instructure.com/" },
            { ...binding, runtimeVerified: false },
            null,
        ].entries()) {
            await bridge.close();
            bridge = await connect();
            bridge.updateBindings([binding]);
            await new Promise(r => setTimeout(r, 30));
            const candidate = await runtime.call("canvas_update_course_settings", { course_id: "42", hide_final_grades: false, _morrow: { operation_id: `review-boundary-${index}`, source_binding_id: binding.sourceBindingId } });
            expect(candidate.isError, JSON.stringify({ index, candidate })).not.toBe(true);
            const candidateId = operationId(candidate);
            runtime.approveOperation(candidateId);
            bridge.updateBindings(changed ? [changed] : []);
            await new Promise(r => setTimeout(r, 30));
            const denial = await runtime.dispatchOperation(candidateId);
            expect(denial.isError).toBe(true);
            expect(JSON.stringify(denial)).not.toContain("provider_effect_target_conflict");
            expect(runtime.effects.get(candidateId)).toMatchObject({ state: "approved", dispatchAttempt: 0 });
            expect(writes).toBe(1);
        }
    }
    finally {
        await bridge?.close();
        await morrow.close();
        rmSync(directory, { recursive: true, force: true });
    }
}, 30000);
