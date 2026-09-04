# Limitations

Morrow `1.0.0-rc.0` is a local release candidate. It is not a public release or a provider authorization claim.

## External evidence not yet available

- The authorized live Canvas scenario has not completed.
- Codex, Claude Code, and Gemini configuration parity is covered by hermetic tests. Codex `0.153.0` and Claude Code `2.1.258` each completed a real sandbox health call against catalog `7d7562326d723b6264abe933add00e166e581aa68c427f8113f197dcc8338f92`. The full client scenario and Gemini execution have not completed. Gemini currently has no configured authentication method.
- The legacy bridge has protocol, authentication, collision, disconnect, and synthetic-extension proof. The live packed extension proof has not completed.
- The public Canvas source-rights manifest is empty. The public package is not cleared for publication.
- Independent clean-machine reproduction has not completed.

## Deliberate product limits

- Canvas is the only enabled LMS provider family.
- MindTap and Connect remain excluded from every runtime catalog and package claim.
- Only explicit course sets can create a batch. Saved-project and discovered course sets stay unavailable until Morrow can bind a gateway-owned complete-coverage receipt.
- Batch concurrency and initial rate controls are frozen in the approved manifest. A run or resume call cannot replace them. During a window, Morrow consumes bounded `io.morrow/canvas-rate` telemetry between waves, uses decimal request-cost and remaining-quota values, reduces later concurrency, and honors bounded `Retry-After` delay without replaying a failed child. A source that does not publish this telemetry still depends on its donor-owned Canvas transport controls.
- A write without an exact frozen readback comparator is refused.
- Undo is refused unless the frozen plan contains exact pre-state or correction facts. The current generated catalog does not advertise such facts.
- A Morrow legacy write can require two human gates. The first gate approves the outer Morrow effect. The second gate belongs to the donor task UI.
- A ExamplePlatform write requires the private edit profile. It starts a new SSH runtime with an exact operation binding. The hermetic catalog profile cannot write.
- A provider timeout, broken pipe, malformed response, or process exit after send becomes `applied_or_unknown`. Morrow does not replay it.
- Large in-process read results use bounded temporary handles. These handles do not survive a gateway restart.
- The sandbox profile is a network-disabled 100-course synthetic estate. It proves deterministic read, write, failure, approval, effect, and readback behavior. It does not prove live Canvas behavior.

## Release behavior

`pnpm package:rc` creates deterministic private and public local candidate archives. Each archive contains a stage manifest, checksums, and a CycloneDX SBOM. Its receipt binds the bytes to one Git commit and tree.

The private candidate can record complete local source-origin evidence. The public candidate remains non-promotable until every included file has an approved source-rights record. Both profiles remain non-promotable until the live Canvas, real-client parity, zero-tolerance, independent reproduction, and publication receipts are current.

`pnpm weekend:check` and `pnpm conformance:report` fail while a required receipt is missing. This failure is intentional.

## Held-provider boundary

The generated donor catalog has 35 held MindTap and Connect rows. Catalog merge removes them before routing. Package scans also reject private CHCP or ExamplePlatform markers from the public candidate.
