# Public source candidate limitations

The `public-canvas` profile retains its historical name. It contains the standalone Morrow MCP and Bridge for Canvas and Moodle, plus the Blackboard Learn REST integration. Normal source setup selects the full supported scope. The included public-Canvas example is an optional restricted configuration. The candidate requires no legacy Morrow or ExamplePlatform runtime. Desktop installers are distributed separately.

It is not published software. Candidate creation does not authorize a provider change, a stable tag, a package-registry release, a Chrome Web Store release, or a public Instructure compatibility claim.

Promotion requires current receipts for:

- per-file source rights;
- the authorization basis for each included provider;
- authorized live Canvas and Moodle operation and readback, with Blackboard's accepted no-live-tenant exception;
- real-client parity;
- independent clean-machine reproduction;
- public package scan, checksums, and SBOM;
- explicit publication authorization.

Canvas and Moodle use the signed-in person's browser permissions. Blackboard uses the configured integration account's REST permissions. Morrow cannot bypass institutional policy, browser controls, roles, New Quizzes access, or Item Bank access. See `LIMITATIONS.md` for exact provider scope and live-test limits.

MindTap, Connect, private institutional material, private paths, credentials, learner identity fixtures, and historical donor runtimes are excluded from the public profile.
