import { isDeepStrictEqual } from "node:util";

export const DESKTOP_RENDERER_SMOKE_SCHEMA = "morrow.desktop-renderer-smoke.v1";

const EXPECTED_RENDERER_SMOKE = Object.freeze({
  schema: DESKTOP_RENDERER_SMOKE_SCHEMA,
  renderer: Object.freeze({ loaded: true, stateRendered: true }),
});

export function isDesktopRendererSmokeReceipt(value, { requireVisible = true } = {}) {
  if (!value || !isDeepStrictEqual({ schema: value.schema, renderer: value.renderer }, EXPECTED_RENDERER_SMOKE)) return false;
  return value.window?.showRequested === true
    && typeof value.window.visible === "boolean"
    && (!requireVisible || value.window.visible === true);
}

export function assertDesktopRendererSmokeReceipt(value, { requireVisible = true } = {}) {
  if (!isDesktopRendererSmokeReceipt(value, { requireVisible })) {
    const visibility = requireVisible ? "visible" : "opened";
    throw new Error(`Morrow renderer smoke did not prove a loaded, state-rendered, ${visibility} desktop window.`);
  }
}
