"""Student privacy boundary for Morrow for Muse.

Two generations live here side by side.

New (faithful port of the desktop Morrow source privacy boundary,
``origin-morrow/packages/gateway-core/src/source-mcp-privacy.ts`` and
``src/privacy.ts``):

- privacy/core.py: exact learner scopes, AES-256-GCM learner vault,
  exact-scope roster, alias machinery, identity-text normalization,
  structural egress redaction, write-direction token resolution.
- privacy/boundary.py: SourceMcpPrivacyBoundary plus the roster/schema
  helpers. This is the de-identification layer the browser lane's
  learner-data completion path invokes
  (transport/browser_backend.py::_project_learner_result, on both the
  request and verify completion phases): learner labels (Student A<n>)
  replace identities on the way out, and the boundary's resolver turns
  labels back into real identities for the provider. Anything
  unverifiable fails closed. The synchronous executor path does not
  project: it refuses learner-data operations outright
  (LearnerDataGated). Paths that neither invoke this boundary nor
  refuse learner-data ops are outside its protection; see
  privacy/FERPA_POLICY.md for the honest scope.

Legacy / reference only. No live path imports these modules; the
shipped de-identification pipeline is privacy/core.py (exact scopes,
AES-256-GCM learner vault, exact-scope roster, alias machinery,
structural egress redaction) plus privacy/boundary.py
(SourceMcpPrivacyBoundary), described above.

- privacy/learner_vault.py: deterministic HMAC tokens for structured
  learner records, educator-side map at ~/.morrow/learner_vault/.
- privacy/pseudonym.py: LEGACY REFERENCE IMPLEMENTATION. Salted
  pseudonyms plus free-text masking; its base64-blob masking
  (Deidentifier._mask_b64) is the in-tree reference for the defense
  the shipped pipeline now implements in privacy/core.py. Salt at
  ~/.morrow/privacy_salt (0600); audit map at
  ~/.morrow/privacy_map.jsonl (0600). Neither ever ships in the
  package; both live only on the educator's VM. See the module header.

De-identification is ON by default for learner-data reads. The only
override is explicit educator consent: a regular file named
`educator_pii_reveal` in the tree-state dir, mode 0600, carrying the
educator's documented instructional purpose (minimum 12 characters).
The reason is journaled verbatim with the op
(`revealed_by: "educator-consent-file"`). The legacy environment
variable `MORROW_REVEAL_STUDENT_PII_REASON` is ignored: it is not a
consent channel. See privacy/FERPA_POLICY.md.
"""

from privacy.core import (
    PrivacyError,
    canonical_json,
    exact_scope,
    is_json_object,
    normalize_learner_identity,
    read_private_file,
    write_private_file,
    LearnerVault,
    LearnerRoster,
    redact_known_learner_text,
    redact_learner_egress,
    redact_learner_egress_batch,
    resolve_learner_tokens,
)
from privacy.boundary import (
    INTERNAL_SOURCE_CAPABILITY_META,
    SourceMcpPrivacyBoundary,
    source_learner_identifier_fields,
    source_privacy_roster,
    canvas_privacy_roster,
    moodle_source_history_available,
    source_privacy_input_schema,
)

__all__ = [
    "PrivacyError",
    "canonical_json",
    "exact_scope",
    "is_json_object",
    "normalize_learner_identity",
    "read_private_file",
    "write_private_file",
    "LearnerVault",
    "LearnerRoster",
    "redact_known_learner_text",
    "redact_learner_egress",
    "redact_learner_egress_batch",
    "resolve_learner_tokens",
    "INTERNAL_SOURCE_CAPABILITY_META",
    "SourceMcpPrivacyBoundary",
    "source_learner_identifier_fields",
    "source_privacy_roster",
    "canvas_privacy_roster",
    "moodle_source_history_available",
    "source_privacy_input_schema",
]
