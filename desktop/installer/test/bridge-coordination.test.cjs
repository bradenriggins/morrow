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
    inspect: async () => assert.fail("inspection must not run"),
    commit: async () => assert.fail("commit must not run"),
    confirm: async () => assert.fail("confirmation must not run"),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { releases += 1; }
  }), (error) => /reload is not confirmed/.test(error.message) && error.code === "bridge_reload_unconfirmed");
  assert.equal(releases, 0);
});

test("a confirmed Bridge update releases only after durable confirmation", async () => {
  const calls = [];
  const completed = await completeBridgeUpdate({
    acquire: async () => { calls.push("acquire"); },
    readback: async () => { calls.push("readback"); return { proof: true }; },
    matchesChallenge: () => true,
    inspect: async () => { calls.push("inspect"); return { quiesceEpoch: "epoch", previousVersion: "1.0.2", version: "1.0.3" }; },
    commit: async () => { calls.push("commit"); },
    confirm: async () => { calls.push("confirm"); },
    refresh: async () => { calls.push("refresh"); return { manualChromeReloadRequired: false }; },
    release: async () => { calls.push("release"); }
  });
  assert.deepEqual(completed, { manualChromeReloadRequired: false });
  assert.deepEqual(calls, ["acquire", "readback", "inspect", "commit", "confirm", "refresh", "release"]);
});

test("a failed or uncertain new-layer commit keeps its maintenance lease and local pending record", async () => {
  const calls = [];
  await assert.rejects(() => completeBridgeUpdate({
    acquire: async () => { calls.push("acquire"); },
    readback: async () => { calls.push("readback"); return { proof: true }; },
    matchesChallenge: () => true,
    inspect: async () => { calls.push("inspect"); return { quiesceEpoch: "epoch", previousVersion: "1.0.2", version: "1.0.3" }; },
    commit: async () => { calls.push("commit"); throw new Error("transport lost"); },
    confirm: async () => assert.fail("local confirmation must remain pending"),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { calls.push("release"); },
  }), /transport lost/);
  assert.deepEqual(calls, ["acquire", "readback", "inspect", "commit"]);
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

test("a Bridge busy refusal releases its maintenance lease", async () => {
  let releases = 0;
  const refusal = Object.assign(new Error("bridge_quiesce_busy"), { code: "bridge_quiesce_busy" });
  await assert.rejects(() => stageBridgeSwap({
    acquire: async () => undefined,
    prepare: async ({ requestQuiescence }) => requestQuiescence({}),
    requestQuiescence: async () => { throw refusal; },
    resumeQuiescence: async () => assert.fail("resume must not run"),
    refresh: async () => assert.fail("refresh must not run"),
    release: async () => { releases += 1; }
  }), (error) => error === refusal);
  assert.equal(releases, 1);
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
