"""Morrow for Muse: conversational per-educator settings (WORKSTREAM B).

The mode model is simple: the ONLY difference between plan and edit
mode is whether writes surface approval. Plan: writes require approval.
Edit: they do not. Reads are unrestricted in both modes.

Edit mode is not timed: it stays on until the educator turns it off.

Agent B contract: Agent A (modes) calls settings.store.get_setting with
the exact signature get_setting(user_id, key), reading "default_mode".
Prefer settings.store.effective_mode(user_id, conversation_id) when a
conversation is in scope: it resolves the educator's most recent
explicit action first (the per-conversation override vs a live
conversation grant, most-recent-wins, override winning ties), then the
persisted default_mode setting.

Stdlib only. No tenant concept exists in this package: settings are
per educator, and nothing here is gated or restricted by tenant.
"""
