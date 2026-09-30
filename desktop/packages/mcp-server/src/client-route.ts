export interface InstalledClientRoute {
  readonly id: string;
  readonly generation: string;
}

export function installedClientRoute(id: unknown, generation: unknown): InstalledClientRoute | null {
  return typeof id === "string" && typeof generation === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    && /^[A-Za-z0-9_-]{43}$/.test(generation)
    ? { id, generation } : null;
}
