import type { NotificationConfiguration } from '../services/notifications.ts';
import type { AppEnv } from './types.ts';

/** Reject malformed configuration instead of silently disabling a safeguard. */
export function integerSetting(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError('Invalid server configuration');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new RangeError('Invalid server configuration');
  return number;
}

export function ingestionOptions(env: AppEnv['Bindings']): { windowMs: number; distinctInstallThreshold: number } {
  return {
    windowMs: integerSetting(env.DETECTION_WINDOW_SECONDS, 1, 86_400) * 1000,
    distinctInstallThreshold: integerSetting(env.DISTINCT_INSTALL_THRESHOLD, 2, 1_000_000)
  };
}

export function notificationConfiguration(env: AppEnv['Bindings'], origin: string): NotificationConfiguration {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Invalid server configuration');
  }
  return {
    dashboardOrigin: url.origin,
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    cooldownMs: integerSetting(env.PUSH_COOLDOWN_SECONDS, 1, 86_400) * 1000,
    ...ingestionOptions(env),
    spikeReportThreshold: integerSetting(env.SPIKE_REPORT_THRESHOLD, 1, 1_000_000),
    requestTimeoutMs: 5000
  };
}
