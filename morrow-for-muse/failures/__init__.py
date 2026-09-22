"""The Morrow error translation layer: failure catalog + translator.

translate(operation, raw_error) turns any raw failure into a specific,
evidence-grounded, actionable message. No shrug is ever rendered.
"""

from .catalog import load_catalog, Catalog, validate_entry
from .translator import translate, match_catalog, TranslatedError
from .funnel import (agent_error_payload, agent_error_text,
                     scrub_secrets, ENGINEERING_LABEL)

__all__ = ["load_catalog", "Catalog", "validate_entry", "translate",
           "match_catalog", "TranslatedError", "agent_error_payload",
           "agent_error_text", "scrub_secrets", "ENGINEERING_LABEL"]
