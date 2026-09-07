"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { completeBridgeUpdate, stageBridgeSwap } = require("../shared/bridge-coordination.cjs");

test("an unconfirmed Bridge reload keeps its maintenance lease", async () => {
  let releases = 0;
  await assert.rejects(() => completeBridgeUpdate({
    acquire: async () => undefined,
    readback: async () => ({ version: "old" }),
    matchesChallenge: () => false,
    confirm: async () => assert.fail("confirmation must not run"),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { releases += 1; }
  }), /reload is not confirmed/);
  assert.equal(releases, 0);
});

test("a confirmed Bridge update releases only after durable confirmation", async () => {
  const calls = [];
  const completed = await completeBridgeUpdate({
    acquire: async () => { calls.push("acquire"); },
    readback: async () => { calls.push("readback"); return { proof: true }; },
    matchesChallenge: () => true,
    confirm: async () => { calls.push("confirm"); },
    refresh: async () => { calls.push("refresh"); return { manualChromeReloadRequired: false }; },
    release: async () => { calls.push("release"); }
  });
  assert.deepEqual(completed, { manualChromeReloadRequired: false });
  assert.deepEqual(calls, ["acquire", "readback", "confirm", "refresh", "release"]);
});

test("a quiesce dispatch that fails keeps its maintenance lease", async () => {
  let releases = 0;
  await assert.rejects(() => stageBridgeSwap({
    acquire: async () => undefined,
    prepare: async ({ requestQuiescence }) => requestQuiescence({}),
    requestQuiescence: async () => { throw new Error("transport lost"); },
    resumeQuiescence: async () => assert.fail("resume must not run"),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { releases += 1; }
  }), /transport lost/);
  assert.equal(releases, 0);
});

test("a failure before quiescence releases its maintenance lease", async () => {
  let releases = 0;
  await assert.rejects(() => stageBridgeSwap({
    acquire: async () => undefined,
    prepare: async () => { throw new Error("stage refused"); },
    requestQuiescence: async () => assert.fail("quiesce must not run"),
    resumeQuiescence: async () => assert.fail("resume must not run"),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { releases += 1; }
  }), /stage refused/);
  assert.equal(releases, 1);
});

test("a verified resume after a failed Bridge swap releases its maintenance lease", async () => {
  let releases = 0;
  await assert.rejects(() => stageBridgeSwap({
    acquire: async () => undefined,
    prepare: async ({ requestQuiescence, resumeQuiescence }) => {
      await requestQuiescence({});
      await resumeQuiescence({ quiesceEpoch: "bridge-update-epoch" });
      throw new Error("swap refused");
    },
    requestQuiescence: async () => ({ quiescent: true }),
    resumeQuiescence: async () => ({ resumed: true }),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { releases += 1; }
  }), /swap refused/);
  assert.equal(releases, 1);
});
