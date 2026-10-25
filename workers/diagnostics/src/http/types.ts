import type { CloudflareAccessVariables } from '@hono/cloudflare-access';

export type AppEnv = {
  Bindings: Cloudflare.Env & { GA4_OAUTH_CREDENTIALS?: string };
  Variables: CloudflareAccessVariables & {
    serverNow: number;
    requestId: string;
    rawJson: unknown;
  };
};
