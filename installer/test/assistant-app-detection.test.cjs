const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { CODEX_BUNDLE_IDENTIFIER, detectAssistantApplication } = require("../shared/assistant-app-detection.cjs");

function readerFixture(directory, entries, identifiers) {
  const readCalls = [];
  return {
    readCalls,
    input: {
      assistantId: "codex",
      applicationDirectories: [directory],
      exists: async (candidate) => entries.has(candidate),
      readBundleIdentifier: async (candidate) => {
        readCalls.push(candidate);
        const value = identifiers.get(candidate);
        if (value instanceof Error) throw value;
        return value || null;
      }
    }
  };
}

test("recognizes ChatGPT.app only when metadata identifies the Codex desktop bundle", async () => {
  const applications = path.join("fixture", "Applications");
  const chatGpt = path.join(applications, "ChatGPT.app");

  const valid = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, CODEX_BUNDLE_IDENTIFIER]]));
  assert.equal(await detectAssistantApplication(valid.input), true);
  assert.deepEqual(valid.readCalls, [chatGpt]);

  const consumerChatGpt = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, "com.openai.chat"]]));
  assert.equal(await detectAssistantApplication(consumerChatGpt.input), false);
  assert.deepEqual(consumerChatGpt.readCalls, [chatGpt]);

  const filenameOnly = readerFixture(applications, new Set([chatGpt]), new Map());
  assert.equal(await detectAssistantApplication(filenameOnly.input), false);
  assert.deepEqual(filenameOnly.readCalls, [chatGpt]);

  const unreadable = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, new Error("unreadable metadata")]]));
  assert.equal(await detectAssistantApplication(unreadable.input), false);
  assert.deepEqual(unreadable.readCalls, [chatGpt]);
});

test("retains known Codex application detection without reading ChatGPT metadata", async () => {
  const applications = path.join("fixture", "Applications");
  const codex = path.join(applications, "Codex.app");
  const input = readerFixture(applications, new Set([codex]), new Map());
  assert.equal(await detectAssistantApplication(input.input), true);
  assert.deepEqual(input.readCalls, []);
});

test("does not apply the ChatGPT bundle exception to another assistant", async () => {
  const applications = path.join("fixture", "Applications");
  const chatGpt = path.join(applications, "ChatGPT.app");
  const fixture = readerFixture(applications, new Set([chatGpt]), new Map([[chatGpt, CODEX_BUNDLE_IDENTIFIER]]));
  fixture.input.assistantId = "claude-code";
  assert.equal(await detectAssistantApplication(fixture.input), false);
  assert.deepEqual(fixture.readCalls, []);
});
