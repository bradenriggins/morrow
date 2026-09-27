"""Student privacy boundary for Morrow for Muse.

Two generations live here side by side.

New (faithful port of the desktop Morrow source privacy boundary,
``origin-morrow/packages/gateway-core/src/source-mcp-privacy.ts`` and
``src/privacy.ts``):

- privacy/core.py: exact learner scopes, AES-256-GCM learner vault,
  exact-scope roster, alias machinery, identity-text normalization,
  structural egress redaction, write-direction token resolution.
- privacy/boundary.py: SourceMcpPrivacyBoundary plus the roster/schema
  helpers. This is the de-identification layer every learner receipt
  passes through (privacy/executor_wire.py:project_learner_result,
  called from dispatch/executor.py dispatch_entry and delegated to by
  transport/browser_backend.py::_project_learner_result): learner
  labels (Student A<n>) replace identities on the way out. Anything
  unverifiable fails closed. People-bearing operations dispatch only on
  the Chromium lane with the encrypted vault; elsewhere they are
  refused (LearnerDataGated).
- privacy/executor_wire.py and privacy/name_echo.py: working by name.
  `morrow students find` issues labels for the name the educator
  typed and records it as educator-introduced for that conversation;
  writes carry labels, which the executor resolves to real ids at the
  LMS boundary and relabels everywhere afterwards. See
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

De-identification is ON for learner-data reads, and nothing turns it
off: no record, flag, file, or environment variable
(`MORROW_REVEAL_STUDENT_PII_REASON` is ignored) reveals names. See
privacy/FERPA_POLICY.md.
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
