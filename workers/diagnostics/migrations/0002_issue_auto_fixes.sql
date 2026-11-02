-- Additive: safe to apply to an existing diagnostics database before deployment.
-- Issues the Worker marked fixed by itself (src/services/auto-fix.ts): the version it set and the state it
-- replaced, so a report from that version or a newer one puts the issue back the way it was.
CREATE TABLE IF NOT EXISTS issue_auto_fixes (
  issue_id INTEGER PRIMARY KEY NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  fixed_in_version TEXT NOT NULL
    CHECK (length(fixed_in_version) BETWEEN 5 AND 64 AND fixed_in_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND fixed_in_version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(fixed_in_version, char(0)) = 0),
  previous_status TEXT NOT NULL CHECK (previous_status IN ('new', 'investigating', 'regressed')),
  previous_fixed_in_version TEXT
    CHECK (previous_fixed_in_version IS NULL OR (length(previous_fixed_in_version) BETWEEN 5 AND 64 AND previous_fixed_in_version GLOB '[0-9]*.[0-9]*.[0-9]*' AND previous_fixed_in_version NOT GLOB '*[^0-9A-Za-z.+-]*' AND instr(previous_fixed_in_version, char(0)) = 0)),
  browsers_json TEXT NOT NULL CHECK (length(browsers_json) <= 256 AND json_valid(browsers_json) AND json_type(browsers_json) = 'array'),
  fixed_at INTEGER NOT NULL CHECK (fixed_at BETWEEN 0 AND 253402300799999),
  CHECK (previous_status <> 'regressed' OR previous_fixed_in_version IS NOT NULL)
) STRICT;
