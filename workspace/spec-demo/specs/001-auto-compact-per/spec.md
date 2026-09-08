# Feature Specification: Auto-compact threshold per session

**Feature Branch**: `001-auto-compact-per`

**Created**: 2026-08-23

**Status**: Draft

**Input**: User description: "auto-compact per session threshold"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator tunes compaction per session (Priority: P1)

Kimi applies a single global auto-compaction threshold today. An operator running a
long research session wants a higher threshold (fewer, later compactions) while a
short scripting session wants the default. They must be able to set this per session
without editing global config for every run.

**Why this priority**: This is the core ask — per-session control. Without it the
feature does not exist.

**Independent Test**: Start a session with an override flag, drive enough context to
cross the override threshold, and assert compaction fires at that threshold (not the
global default). Delivers value standalone.

**Acceptance Scenarios**:

1. **Given** a global default of 100k tokens, **When** a session starts with override `auto_compact_threshold=200k`, **Then** compaction first fires after ~200k tokens.
2. **Given** a session with override `auto_compact_threshold=200k`, **When** no override is passed in a later session, **Then** that later session uses the 100k global default.

---

### User Story 2 - Config-driven default via config.toml (Priority: P2)

An operator wants to set a project-wide default in `config.toml` so every session in
that project inherits it unless overridden.

**Why this priority**: Convenience for repeated work in one project; builds on Story 1.

**Independent Test**: Set `[context] auto_compact_threshold` in `config.toml`, start a
session with no flag, assert it uses the configured value.

**Acceptance Scenarios**:

1. **Given** `config.toml` with `[context] auto_compact_threshold = 150k`, **When** a session starts without a flag, **Then** compaction uses 150k.
2. **Given** an invalid value (negative / non-integer), **When** the session starts, **Then** it errors clearly and falls back to the hard-coded default rather than crashing.

---

### User Story 3 - Session override takes precedence (Priority: P2)

When both `config.toml` and a session flag are present, the session flag wins.

**Why this priority**: Precedence clarity prevents silent misconfiguration.

**Independent Test**: config=150k, flag=80k → assert 80k wins.

**Acceptance Scenarios**:

1. **Given** config=150k and flag=80k, **When** the session starts, **Then** effective threshold is 80k.

---

### Edge Cases

- What happens when the override exceeds the model context window? → Clamp to a safe
  max and warn; never compact beyond what the window allows.
- How does the system handle a missing `config.toml`? → Use the existing global default.
- What if compaction is disabled globally? → The per-session threshold is ignored;
  document this in the flag help.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST read `auto_compact_threshold` (integer tokens) from the `[context]` table in `config.toml`.
- **FR-002**: System MUST accept a per-session override (flag/env) that takes precedence over `config.toml`.
- **FR-003**: System MUST fall back to the existing global default when neither `config.toml` nor the override is set.
- **FR-004**: System MUST validate the threshold is a positive integer and reject invalid values with a clear error.
- **FR-005**: System MUST clamp the effective threshold to a safe maximum relative to the model context window.

### Key Entities

- **SessionConfig**: holds `effective_threshold`, resolved from override > config.toml > global default.
- **GlobalConfig**: the existing global auto-compaction setting (unchanged behavior when unset).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A session with an override compacts at the override threshold within ±5% of the specified token count.
- **SC-002**: 100% of invalid-threshold inputs produce a clear error and fall back to default (no crash).
- **SC-003**: Precedence override > config > global holds across all 3 combinations in tests.

## Assumptions

- The underlying compaction mechanism is unchanged; only the threshold resolution is added.
- `config.toml` parsing already exists in the project; this reuses it.
- Token counts used for the threshold are the same unit the existing global default uses.
