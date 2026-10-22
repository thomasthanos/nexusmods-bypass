import { errorReportSchema, MAX_BODY_BYTES } from '../src/schemas/ingest.ts';
import type { ErrorReportInput } from '../src/schemas/ingest.ts';

export type PreparedReport = Readonly<{ url: string; report_id: string; body: string }>;

type ExampleOptions = {
  relayOrigin: string;
  diagnosticsOptedIn: boolean;
  // A crypto.randomUUID() value persisted in extension-local storage after opt-in.
  // Never use an account ID, email, Nexus API key, or browser fingerprint here.
  anonymousInstallSeed: string;
  version: string;
  browser: ErrorReportInput['browser'];
  browserVersion: string;
  os: ErrorReportInput['os'];
};

export async function prepareExampleReport(options: ExampleOptions): Promise<PreparedReport | null> {
  if (!options.diagnosticsOptedIn) return null;

  const origin = new URL(options.relayOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Use the HTTPS origin of the diagnostics Worker');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.anonymousInstallSeed)) {
    throw new Error('The installation seed must be a locally generated random UUID');
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(options.anonymousInstallSeed));
  const install_id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const report = errorReportSchema.parse({
    schema_version: 1,
    consent: 'diagnostics-v1',
    report_id: crypto.randomUUID(),
    install_id,
    occurred_at: new Date().toISOString(),
    version: options.version,
    browser: options.browser,
    browser_version: options.browserVersion,
    os: options.os,
    download_mode: 'auto',
    destination: 'vortex',
    severity: 'error',
    error_category: 'HANDOFF',
    error_code: 'NXM_TIMEOUT',
    failure_stage: 'VORTEX_NXM_HANDOFF_FAILED',
    error_message: 'Vortex did not acknowledge the nxm protocol handoff',
    breadcrumbs: [
      { timestamp_offset_ms: 0, stage: 'UI', action: 'UI_CLICK_DOWNLOAD', status: 'ok' },
      { timestamp_offset_ms: 310, stage: 'API', action: 'PRIMARY_API_REQUEST', status: 'warn', http_status: 429, duration_ms: 310, metadata: { retry_after: '60' } },
      { timestamp_offset_ms: 730, stage: 'API', action: 'FALLBACK_API_REQUEST', status: 'ok', http_status: 200, duration_ms: 420 },
      { timestamp_offset_ms: 5730, stage: 'HANDOFF', action: 'VORTEX_NXM_HANDOFF_FAILED', status: 'error', duration_ms: 5000 }
    ],
    context: { online: navigator.onLine }
  } satisfies ErrorReportInput);

  const body = JSON.stringify(report);
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new Error('Report exceeds the request limit');
  }
  return Object.freeze({ url: new URL('/api/ingest', origin).href, report_id: report.report_id, body });
}

// Retain the prepared object for retries. Never regenerate its UUID or counters.
// Read current consent immediately before each attempt, including queued retries.
export async function sendPreparedReport(report: PreparedReport, diagnosticsStillOptedIn: boolean): Promise<boolean> {
  if (!diagnosticsStillOptedIn) return false;
  const response = await fetch(report.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: report.body,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Diagnostics request failed with HTTP ${response.status}`);
  return true;
}
