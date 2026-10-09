export const LEGACY_BRIDGE_OVERLAY_DIGEST = "5415922fc91242d552f6a4374d9df67a89aa007a40a4b11ed2c8f902cba98621";

export function legacyBridgeRuntimeRevision(donorRevision: string): string {
  const revision = String(donorRevision || "").trim();
  if (!revision) throw new TypeError("donor revision is required");
  return `${revision}:${LEGACY_BRIDGE_OVERLAY_DIGEST}`;
}
