import { RELAYED_INSTALL_ID } from '../schemas/ingest.ts';

/** SQL for an installation column that never counts the placeholder of relayed reports. */
export function countedInstall(column: string): string {
  return `NULLIF(${column},'${RELAYED_INSTALL_ID}')`;
}

/** SQL for an issue's lifetime count of relayed reports; receipts outlive report bodies. */
export function relayedReportCount(issue: string): string {
  return `(SELECT COUNT(*) FROM report_receipts WHERE issue_id=${issue}.id AND install_id='${RELAYED_INSTALL_ID}') AS relayed_report_count`;
}
