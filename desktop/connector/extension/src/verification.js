// The readback planner, its evaluator and the retained recovery descriptor are
// generated from packages/canvas-api-catalog/src/readback-plan.ts, so the
// extension and Morrow's gateway judge one Canvas postcondition by one rule.
export {
  evaluateBrowserReadback,
  planBrowserReadback,
  planCanvasRecoveryDescriptor,
} from "../generated/canvas-readback-plan.js";
