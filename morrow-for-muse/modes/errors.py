#!/usr/bin/env python3
"""Failure modes for the Morrow for Muse mode system (Workstream A).

Exception names are the contract with failures/catalog.json (Workstream C):
the translator matches by class NAME and merges scalar exception attributes
(course_id, grant_id, plan_id, setting_name, mode, query, candidates_public,
match_count) as evidence. Keep the names stable; never rename them.

Conventions (from the Workstream C evidence contract):
  - AmbiguousCourseWriteRefused carries query and candidates_public.
  - ModeSettingsTamper carries setting_name when the problem is a
    settings value.
  - ModeGrantExpired / ModeGrantRevoked carry grant_id.

Stdlib only.
"""

from __future__ import annotations


class ModeError(Exception):
    """Base class for every mode-system failure.

    Accepts scalar evidence attributes as keyword arguments
    (grant_id=..., course_id=..., query=..., candidates_public=...,
    setting_name=..., mode=...); they are also settable as plain
    attributes after construction.
    """

    def __init__(self, message="", **attrs):
        super().__init__(message)
        for key, value in attrs.items():
            setattr(self, key, value)


class ModeSelfGrantRefused(ModeError):
    """The agent tried to enter edit mode without an educator-issued
    confirmation: request_edit_grant with a missing or invalid
    educator confirmation, or switch_mode to "edit". Edit mode is
    educator-granted only; the agent must never promote itself."""


class ModeGrantExpired(ModeError):
    """A timed edit grant lapsed before the write was attempted.
    Carries grant_id and course_id."""


class ModeGrantRevoked(ModeError):
    """The edit grant was revoked (switch to plan, supersede, or
    explicit revoke) before the write was attempted. Carries grant_id
    and course_id."""


class AmbiguousCourseWriteRefused(ModeError):
    """A write was attempted while the course target was ambiguous:
    the resolution confidence was below threshold and the user had not
    confirmed the course. Never write on a guessed course. Carries
    query, candidates_public, and course_id when known."""


class ModeSettingsTamper(ModeError):
    """Mode-related persisted state failed validation: a grant file
    whose tamper seal does not verify, an unreadable grant file, or an
    invalid stored settings value. Carries setting_name when the
    problem is a settings value."""


class DestructiveConfirmationRequired(ModeError):
    """A destructive write (currently: HTTP DELETE, or an entry
    explicitly marked destructive) was attempted in edit mode while
    the educator's confirm_destructive_writes setting is on, without a
    recorded educator confirmation for that specific destructive
    action. The agent must surface what will be destroyed and get an
    explicit yes before retrying with destructive_confirmed. Carries
    entry_name and course_id."""


class PlanModeWriteWithoutApproval(ModeError):
    """A write was attempted in plan mode with no educator-approved
    validated plan on file: the mode gate deferred to the legacy
    approval path, which found no signed approval record. The legacy
    WriteApprovalMissing is kept as the cause. Carries plan_id when
    known, and course_id."""
