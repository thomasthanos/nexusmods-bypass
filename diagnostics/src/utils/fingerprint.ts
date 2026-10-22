import { parse } from 'error-stack-parser-es';
import type { ErrorReport } from '../schemas/ingest.ts';
import { sanitizeReport, sanitizeText, sanitizeUrl } from './sanitize.ts';

const UNKNOWN_FRAME = '<unknown>';

function recognizableFile(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:[\\/]|\/|\.{1,2}\/)/i.test(value)
    || /(?:^|[\\/])[^@:\s]+\.(?:[cm]?[jt]sx?|html?|wasm)(?::\d+)*$/i.test(value);
}

/** All source positions are removed: extension bundles do not reliably identify minified frames. */
export function normalizeStack(stack: string | undefined): string {
  if (!stack?.trim()) return UNKNOWN_FRAME;
  // Parse the stack grammar before sanitizing each emitted component: Firefox's relative
  // function@file.js syntax can otherwise be mistaken for a private email address.
  const parserStack = stack.slice(0, 12_000).split('\n').slice(0, 80).map((line) => {
    // URL query removal can also consume a trailing stack position. The parser needs a position
    // to recognize V8 frames, so supply a synthetic one; no positions enter normalized output.
    if (/^\s*at\s+/.test(line) && !/:\d+(?::\d+)?\)?$/.test(line)) {
      return line.endsWith(')') ? `${line.slice(0, -1)}:0:0)` : `${line}:0:0`;
    }
    return line;
  }).join('\n');
  try {
    const error = new Error();
    error.stack = parserStack;
    const frames = parse(error).flatMap((frame) => {
      if (!frame.fileName || !recognizableFile(frame.fileName)) return [];
      if (frame.lineNumber === undefined && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[A-Za-z]:[\\/]|\/)/i.test(frame.fileName)) return [];
      let file = sanitizeUrl(frame.fileName).replace(/:\d+(?::\d+)?$/, '');
      file = file.replace(/^(?:chrome|moz|safari-web)-extension:\/\/[^/]*\//i, 'extension:///');
      const name = sanitizeText(frame.functionName ?? '<anonymous>').replace(/\([^)]*\)/g, '').replace(/[\r\n]/g, ' ').trim().slice(0, 120) || '<anonymous>';
      return [`${name}@${file.slice(0, 512)}`];
    }).slice(0, 20);
    return frames.length > 0 ? frames.join('\n').slice(0, 12_000) : UNKNOWN_FRAME;
  } catch {
    return UNKNOWN_FRAME;
  }
}

export function normalizedTopFrame(stack: string | undefined): string {
  return normalizeStack(stack).split('\n')[0] ?? UNKNOWN_FRAME;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintReport(report: ErrorReport): Promise<{
  fingerprint: string;
  normalized_top_frame: string;
  normalized_stack: string;
}> {
  const safeReport = sanitizeReport(report);
  const normalized_stack = normalizeStack(report.stack_trace);
  const normalized_top_frame = normalized_stack.split('\n')[0] ?? UNKNOWN_FRAME;
  const fingerprint = await sha256(JSON.stringify([
    safeReport.error_category, safeReport.error_code, safeReport.failure_stage, normalized_top_frame, safeReport.destination
  ]));
  return { fingerprint, normalized_top_frame, normalized_stack };
}
