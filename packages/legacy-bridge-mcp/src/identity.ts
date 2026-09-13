export const LEGACY_BRIDGE_OVERLAY_DIGEST = "c08c88dee4a3f526109b03a1f88341beb6277d7b41dcd57d47f8972dd0a6bf15";

export function legacyBridgeRuntimeRevision(donorRevision: string): string {
  const revision = String(donorRevision || "").trim();
  if (!revision) throw new TypeError("donor revision is required");
  return `${revision}:${LEGACY_BRIDGE_OVERLAY_DIGEST}`;
}
