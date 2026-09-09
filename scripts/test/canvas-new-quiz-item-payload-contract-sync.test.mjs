import assert from "node:assert/strict";
import test from "node:test";
import { syncNewQuizItemPayloadContract } from "../sync-new-quiz-item-payload-contract.mjs";

test("the Bridge uses the generated complete New Quiz item payload contract", () => {
  assert.deepEqual(syncNewQuizItemPayloadContract({ check: true }).check, true);
});
