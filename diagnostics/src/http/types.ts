import type { CloudflareAccessVariables } from '@hono/cloudflare-access';

export type AppEnv = {
  Bindings: Cloudflare.Env;
  Variables: CloudflareAccessVariables & {
    serverNow: number;
    requestId: string;
    rawJson: unknown;
  };
};
