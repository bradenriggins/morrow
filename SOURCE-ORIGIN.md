# Source origin

Morrow's default runtime is directly owned source in this repository. It does not import or execute source from another private repository.

## Source classes

### Direct Morrow source

The MCP server, operation journal, effect broker, batch engine, privacy layer, client installer, loopback protocol, Canvas connector MCP, Chrome extension, verification logic, package tooling, and documentation are maintained in `bradenriggins/morrow`.

Each public-candidate file needs one exact digest record before publication. A repository location or authorship claim does not replace that review.

### Generated Canvas catalog

`scripts/generate-canvas-api-catalog.mjs` retrieves the current public Canvas API definition index and its resource definitions. It converts them into normalized Morrow operation rows. The generated artifact records the upstream URLs, source digest, last-modified value, operation counts, and final catalog digest.

The generator adds thirteen explicit New Quizzes Item Bank contracts for the signed-browser connector. These rows are maintained as Morrow source and tested against exact request behavior.

Generated metadata does not by itself grant publication rights. The public package gate must record the intended use and reviewed rights basis.

### Historical behavior references

Earlier Morrow and ExamplePlatform systems informed the required safety properties: typed operations, separate approval, effect receipts, readback, privacy projection, durable batches, restart recovery, and honest uncertain outcomes.

The standalone runtime does not need either system. Historical comparison files and fixtures are not included in the public source profile. No private repository history, credentials, institutional data, learner records, private deployment configuration, or covered course content may enter a public candidate.

## Prohibited material

- Canvas credentials, cookies, CSRF values, or session tokens;
- New Quizzes or Item Bank bearer tokens;
- real learner identity or covered course content;
- private institutional paths, doctrine, responses, or deployment configuration;
- harvested MindTap or Connect methods;
- copied private source without an exact reviewed origin record.

## Release records

- `config/source-rights.manifest.json` contains per-file publication review.
- `config/source-origin-ledger.json` binds tracked files to a Git revision and digest.
- `config/release-profiles.json` defines private and public candidate boundaries.
- `docs/release/PUBLIC-CANVAS-LIMITATIONS.md` states current external gates.

Source review, provider-policy review, and publication authorization remain separate decisions. A successful build or package scan cannot create those approvals.
