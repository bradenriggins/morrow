# Morrow

Models reason. Morrow safely operates learning systems.

Morrow is a local, model-neutral LMS operations layer for MCP-compatible AI clients. It provides typed Canvas operations, bounded authority, reviewed plans, separate approval, durable effect records, fresh provider readback, multi-course execution, privacy controls, and evidence.

## Repository status

This is the clean implementation repository for the new Morrow operations layer. Development begins from proven behavior in two private donor systems:

- `morrow-legacy`, which contains the existing Morrow Canvas tooling, planners, approval flows, privacy controls, workflows, reports, and verification logic.
- `chcp-team-agent-kit`, which contains Meridian's typed MCP surface, provider binding, durable effect broker, batch recovery, local workspace services, and operational failure history.

The donor repositories remain private reference systems. This repository will receive only publication-cleared source, clean implementations, synthetic fixtures, and origin records.

## Initial provider scope

Canvas is the initial supported LMS. MindTap and Connect remain disabled pending written permission or formal developer terms that cover automation and open-source publication.

## Current implementation phase

The first implementation phase assembles a working federation gateway around the existing donor capabilities. It will:

1. Export and reconcile the existing Canvas tool catalogs.
2. Run Meridian as an internal MCP upstream during convergence.
3. Expose Morrow-native operations through a bounded adapter.
4. Route every mutation through durable effect and approval controls.
5. Preserve child-level truth for multi-course work.
6. Produce one generated public catalog and one canonical result envelope.

See `docs/implementation/WEEKEND-CONVERGENCE.md` once the first implementation branch lands.
