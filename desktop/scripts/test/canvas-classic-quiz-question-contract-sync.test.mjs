import test from "node:test";
import { syncClassicQuizQuestionContract } from "../sync-classic-quiz-question-contract.mjs";

test("the Bridge embeds the exact Classic Quiz question provider contract", () => {
  syncClassicQuizQuestionContract({ check: true });
});
