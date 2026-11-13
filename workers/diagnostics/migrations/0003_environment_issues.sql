-- Data only: safe to apply to an existing diagnostics database before deployment, and to apply again.
-- The rule engine (src/services/ruleEngine.ts) now names a 5xx answer from Nexus Mods (UPSTREAM_SERVER_ERROR),
-- a timeout (NETWORK_TIMEOUT) and a download the network dropped (NETWORK_UNREACHABLE). A report keeps the
-- rule output it was stored with and an issue takes its category from its newest report, so an issue the
-- engine now names stayed UNKNOWN_ERROR until it happened again. These statements name it now, from the
-- issue's own codes and its newest report's HTTP status or the status that opens its message, in the
-- engine's order. An issue the engine names some other way waits for its next report.
UPDATE issues SET category = 'UPSTREAM_SERVER_ERROR', fault_origin = 'upstream_site',
  suggested_action = 'Έλεγχος αν συμπίπτει με διακοπή του Nexus (5xx από τον server του ή 52x από το Cloudflare που δεν τον φτάνει) πριν χαρακτηριστεί σφάλμα της επέκτασης.'
WHERE category = 'UNKNOWN_ERROR' AND (
  upper(replace(replace(replace(error_category, '.', '_'), ':', '_'), '-', '_')) IN ('SERVER_ERROR', 'UPSTREAM_SERVER_ERROR')
  OR upper(replace(replace(replace(error_code, '.', '_'), ':', '_'), '-', '_')) IN ('SERVER_ERROR', 'UPSTREAM_SERVER_ERROR')
  OR upper(replace(replace(replace(failure_stage, '.', '_'), ':', '_'), '-', '_')) IN ('SERVER_ERROR', 'UPSTREAM_SERVER_ERROR')
  OR id IN (
    SELECT newest.issue_id FROM reports AS newest
    WHERE newest.rowid = (
        SELECT latest.rowid FROM reports AS latest WHERE latest.issue_id = newest.issue_id
        ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1
      )
      AND (newest.http_status BETWEEN 500 AND 599
        OR newest.error_message GLOB 'HTTP 5[0-9][0-9]' OR newest.error_message GLOB 'HTTP 5[0-9][0-9][^0-9A-Za-z_]*'
        OR (instr(newest.error_message, ' | HTTP 5') BETWEEN 2 AND 65
          AND substr(newest.error_message, 1, instr(newest.error_message, ' | HTTP 5') - 1) GLOB '[a-z]*'
          AND substr(newest.error_message, 1, instr(newest.error_message, ' | HTTP 5') - 1) NOT GLOB '*[^a-z0-9_]*'
          AND (substr(newest.error_message, instr(newest.error_message, ' | HTTP 5') + 3) GLOB 'HTTP 5[0-9][0-9]'
            OR substr(newest.error_message, instr(newest.error_message, ' | HTTP 5') + 3) GLOB 'HTTP 5[0-9][0-9][^0-9A-Za-z_]*')))
  )
);

UPDATE issues SET category = 'NETWORK_UNREACHABLE', fault_origin = 'client_env',
  suggested_action = 'Έλεγχος διαδρομής/σύνδεσης ή DNS/Firewall χρήστη· η αιτία παραμένει άγνωστη χωρίς επιπλέον στοιχεία δικτύου.'
WHERE category = 'UNKNOWN_ERROR' AND (
  upper(replace(replace(replace(error_category, '.', '_'), ':', '_'), '-', '_')) IN ('NETWORK_FAILED', 'NETWORK_DISCONNECTED')
  OR upper(replace(replace(replace(error_code, '.', '_'), ':', '_'), '-', '_')) IN ('NETWORK_FAILED', 'NETWORK_DISCONNECTED')
  OR upper(replace(replace(replace(failure_stage, '.', '_'), ':', '_'), '-', '_')) IN ('NETWORK_FAILED', 'NETWORK_DISCONNECTED')
);

UPDATE issues SET category = 'NETWORK_TIMEOUT', fault_origin = 'unknown',
  suggested_action = 'Έλεγχος αν συμπίπτει με αργή απόκριση ή διακοπή του Nexus· χωρίς απάντηση μέσα στο όριο, η καθυστέρηση μπορεί να είναι στο δίκτυο του χρήστη ή στο Nexus.'
WHERE category = 'UNKNOWN_ERROR' AND (
  upper(replace(replace(replace(error_category, '.', '_'), ':', '_'), '-', '_')) IN ('TIMEOUT', 'TIMED_OUT', 'REQUEST_TIMEOUT', 'NETWORK_TIMEOUT', 'ETIMEDOUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT')
  OR upper(replace(replace(replace(error_code, '.', '_'), ':', '_'), '-', '_')) IN ('TIMEOUT', 'TIMED_OUT', 'REQUEST_TIMEOUT', 'NETWORK_TIMEOUT', 'ETIMEDOUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT')
  OR upper(replace(replace(replace(failure_stage, '.', '_'), ':', '_'), '-', '_')) IN ('TIMEOUT', 'TIMED_OUT', 'REQUEST_TIMEOUT', 'NETWORK_TIMEOUT', 'ETIMEDOUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT')
);

-- No release fixes these categories (ENVIRONMENT_CATEGORIES), so the Worker no longer marks them fixed by
-- itself (src/services/auto-fix.ts). One it did mark fixed went regressed at the next outage, and is open
-- again as it was before.
UPDATE issues SET status = 'new', fixed_in_version = NULL,
  updated_at = max(updated_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
WHERE status = 'regressed' AND category IN (
  'NETWORK_UNREACHABLE', 'NETWORK_TIMEOUT', 'UPSTREAM_SERVER_ERROR', 'API_RATE_LIMIT',
  'SECURITY_BLOCK', 'EXTENSION_CONFLICT', 'HANDOFF_FAILURE'
);
