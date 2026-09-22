import assert from "node:assert/strict";
import test from "node:test";
import { launchManagedChromiumPersistentContext } from "../lib/playwright-managed-browser.mjs";

test("the browser harness launcher delegates to Playwright without a system-browser override", async () => {
  const calls = [];
  const chromium = {
    async launchPersistentContext(profile, options) {
      calls.push({ profile, options });
      return { managed: true };
    },
  };
  assert.deepEqual(await launchManagedChromiumPersistentContext(chromium, "/tmp/profile", { headless: false }), { managed: true });
  assert.deepEqual(calls, [{ profile: "/tmp/profile", options: { headless: false } }]);
});

test("the browser harness launcher refuses channel and executable overrides", async () => {
  const chromium = { launchPersistentContext: async () => assert.fail("an override reached Playwright") };
  await assert.rejects(
    launchManagedChromiumPersistentContext(chromium, "/tmp/profile", { channel: "chrome" }),
    /playwright_managed_chromium_override_refused/,
  );
  await assert.rejects(
    launchManagedChromiumPersistentContext(chromium, "/tmp/profile", { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }),
    /playwright_managed_chromium_override_refused/,
  );
});
