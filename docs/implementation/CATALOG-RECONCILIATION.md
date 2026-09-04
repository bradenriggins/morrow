# Canvas catalog generation

Morrow uses one deterministic standalone Canvas catalog. It does not merge live donor registries at runtime.

## Generate

```bash
pnpm catalog:export
```

The generator reads the public Canvas API definition index, retrieves each advertised resource definition, normalizes the operations, adds the explicit Item Bank bridge contract, and writes:

- `artifacts/canvas-api/canvas-api-catalog.json`;
- `connector/extension/generated/canvas-api-catalog.json`.

Both files must be byte-identical.

## Validate

```bash
pnpm catalog:merge
pnpm catalog:check
pnpm morrow catalog stats --json
```

Validation proves:

- stable ordering and byte-identical regeneration;
- unique operation keys and MCP tool names;
- exact decimal-string schemas for 64-bit Canvas IDs;
- an explicit read or write risk class;
- an explicit profile state;
- an explicit connector route and readback owner;
- no enabled MindTap or Connect prefix;
- matching MCP and extension catalog digests;
- all twelve Item Bank operations are present.

## Drift behavior

The catalog records the provider source digest and last-modified value. A provider definition change changes the Morrow catalog digest. Startup and extension pairing refuse mismatched digests.

Generated definitions are reviewed input, not unchecked authority. Any unsupported schema shape or missing request location must block the affected row until the generator has an explicit sanitation rule.

## Discovery

The gateway can register the complete catalog because the default limit is 2,000 tools. Clients should still use `morrow_catalog_search` and bounded catalog pages instead of loading or guessing the full surface in a prompt.
