import { z } from 'zod';

export const MAX_BODY_BYTES = 65_536;
export const MAX_BREADCRUMBS = 80;
export const MAX_COUNTER = 1_000_000;

const identifier = z.string().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);
const shortVersion = z.string().min(1).max(40).regex(/^[A-Za-z0-9._+ -]+$/);
const hasNoNul = (value: string): boolean => !value.includes('\u0000');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const versionSchema = z.string().max(64).regex(semverPattern).refine((value) => {
  const precedence = value.split('+')[0] ?? '';
  return precedence.split(/[.-]/).every((part) => !/^\d+$/.test(part) || Number.isSafeInteger(Number(part)));
}, 'Numeric version components must be safe integers');

export const installIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const browserSchema = z.enum(['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'other']);
export const osSchema = z.enum(['windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'other']);
export const destinationSchema = z.enum(['browser', 'vortex', 'mo2']);
export const severitySchema = z.enum(['debug', 'info', 'warning', 'error', 'fatal']);

export const timestampSchema = z.iso.datetime({ precision: 3 }).refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value;
}, 'Expected a real UTC timestamp with millisecond precision');

export const metricDateSchema = z.iso.date().refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, 'Expected a real UTC calendar date');

type JsonScalar = string | number | boolean | null;
export type MetadataValue = JsonScalar | MetadataValue[] | { [key: string]: MetadataValue };

const metadataKey = z.string().min(1).max(48).regex(/^[A-Za-z0-9_.:-]+$/)
  .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe metadata key');
const scalarSchema = z.union([
  z.string().max(1024),
  z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
  z.null()
]);

function boundedRecord(value: z.ZodType<MetadataValue>) {
  return z.preprocess((input, ctx) => {
    if (input && typeof input === 'object' && Object.keys(input).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) {
      ctx.addIssue({ code: 'custom', message: 'Unsafe metadata key' });
      return z.NEVER;
    }
    return input;
  }, z.record(metadataKey, value).refine((record) => Object.keys(record).length <= 32, 'At most 32 metadata keys'));
}

// Construct a finite schema instead of accepting unrestricted recursive JSON.
let metadataValue: z.ZodType<MetadataValue> = scalarSchema;
for (let level = 0; level < 2; level += 1) {
  metadataValue = z.union([scalarSchema, z.array(metadataValue).max(16), boundedRecord(metadataValue)]);
}
export const metadataSchema = boundedRecord(metadataValue);

export const breadcrumbSchema = z.strictObject({
  timestamp_offset_ms: z.number().int().min(0).max(86_400_000),
  stage: identifier,
  action: identifier,
  status: z.enum(['ok', 'warn', 'error']),
  http_status: z.number().int().min(100).max(599).optional(),
  duration_ms: z.number().int().min(0).max(86_400_000).optional(),
  metadata: metadataSchema.default({})
});

const breadcrumbsSchema = z.array(breadcrumbSchema).max(MAX_BREADCRUMBS).superRefine((items, ctx) => {
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1];
    const current = items[index];
    if (previous && current && current.timestamp_offset_ms < previous.timestamp_offset_ms) {
      ctx.addIssue({ code: 'custom', message: 'Breadcrumbs must be chronological', path: [index, 'timestamp_offset_ms'] });
    }
  }
});

export const domStateSchema = z.strictObject({
  document_ready_state: z.enum(['loading', 'interactive', 'complete']),
  page_kind: z.enum(['mod', 'collection', 'other']),
  collection_host_present: z.boolean().optional(),
  selectors: z.array(z.strictObject({
    selector: z.string().min(1).max(200),
    matched: z.boolean(),
    match_count: z.number().int().min(0).max(10_000).optional()
  })).max(20).default([]),
  api_schema: z.strictObject({
    expected: z.string().min(1).max(128).optional(),
    received: z.string().min(1).max(128).optional(),
    missing_fields: z.array(identifier).max(20).default([])
  }).optional()
});

const endpointSchema = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Endpoint must use HTTPS without credentials, query parameters, or fragments');

const contextSchema = z.strictObject({
  api_endpoint: endpointSchema.optional(),
  online: z.boolean().optional()
});

// This checks the parsed representation. Phase 3 must also cap the raw request
// stream before JSON parsing, including whitespace and chunked request bodies.
function enforcePayloadBudget(value: unknown, ctx: z.RefinementCtx): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BODY_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Payload exceeds 65,536 UTF-8 bytes' });
  }
}

export const errorReportSchema = z.strictObject({
  schema_version: z.literal(1),
  consent: z.literal('diagnostics-v1'),
  report_id: z.uuidv4().toLowerCase(),
  install_id: installIdSchema,
  occurred_at: timestampSchema,
  version: versionSchema,
  browser: browserSchema,
  browser_version: shortVersion,
  os: osSchema,
  os_version: shortVersion.optional(),
  mod_id: z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => Number.isSafeInteger(Number(value)), 'Unsafe mod ID').optional(),
  collection_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  download_mode: z.enum(['manual', 'auto']),
  destination: destinationSchema,
  severity: severitySchema,
  error_category: identifier,
  error_code: identifier,
  failure_stage: identifier,
  error_name: z.string().min(1).max(120).refine(hasNoNul, 'NUL characters are not allowed').default('Error'),
  error_message: z.string().min(1).max(2048).refine(hasNoNul, 'NUL characters are not allowed'),
  stack_trace: z.string().max(12_000).refine(hasNoNul, 'NUL characters are not allowed').optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  retry_after: z.string().min(1).max(128).refine(hasNoNul, 'NUL characters are not allowed').optional(),
  breadcrumbs: breadcrumbsSchema.default([]),
  dom_state: domStateSchema.optional(),
  context: contextSchema.default({})
}).superRefine(enforcePayloadBudget);

const counterSchema = z.number().int().min(0).max(MAX_COUNTER);

export const heartbeatSchema = z.strictObject({
  schema_version: z.literal(1),
  consent: z.literal('telemetry-v1'),
  heartbeat_id: z.uuidv4().toLowerCase(),
  install_id: installIdSchema,
  metric_date: metricDateSchema,
  version: versionSchema,
  browser: browserSchema,
  destination: destinationSchema,
  attempts_count: counterSchema,
  success_count: counterSchema,
  fallback_triggered_count: counterSchema
}).superRefine((value, ctx) => {
  for (const field of ['success_count', 'fallback_triggered_count'] as const) {
    if (value[field] > value.attempts_count) {
      ctx.addIssue({ code: 'custom', message: `${field} cannot exceed attempts_count`, path: [field] });
    }
  }
  enforcePayloadBudget(value, ctx);
});

export type ErrorReportInput = z.input<typeof errorReportSchema>;
export type ErrorReport = z.output<typeof errorReportSchema>;
export type HeartbeatInput = z.input<typeof heartbeatSchema>;
export type Heartbeat = z.output<typeof heartbeatSchema>;
export type Breadcrumb = z.output<typeof breadcrumbSchema>;
