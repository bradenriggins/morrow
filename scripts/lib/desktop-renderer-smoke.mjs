import { isDeepStrictEqual } from "node:util";

export const DESKTOP_RENDERER_SMOKE_SCHEMA = "morrow.desktop-renderer-smoke.v1";

const EXPECTED_RENDERER_SMOKE = Object.freeze({
  schema: DESKTOP_RENDERER_SMOKE_SCHEMA,
  renderer: Object.freeze({ loaded: true, stateRendered: true }),
  window: Object.freeze({ visible: true }),
});

export function isDesktopRendererSmokeReceipt(value) {
  return isDeepStrictEqual(value, EXPECTED_RENDERER_SMOKE);
}

export function assertDesktopRendererSmokeReceipt(value) {
  if (!isDesktopRendererSmokeReceipt(value)) {
    throw new Error("Morrow renderer smoke did not prove a loaded, state-rendered, visible desktop window.");
  }
}
