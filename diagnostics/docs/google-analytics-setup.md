# Connect the existing Chrome Web Store analytics property

The dashboard reads property **547084285** in account **402123653**. This Google-managed property measures the extension's **Chrome Web Store listing visitors and installs**. Its realtime users are visitors active in the last 30 minutes; they are not a count of people currently running the extension. The connection reads existing reports and adds no extension tracking.

Chrome Web Store grants a fixed Analytics role and manages additional access through publisher membership. Use the Google account that already sees this property. No publisher invitations, service account, replacement property, or collection changes are needed. [Chrome Web Store Analytics documentation](https://developer.chrome.com/docs/webstore/google-analytics)

## Prepare a dedicated Google OAuth client

1. Select a Google Cloud project and enable **Google Analytics Data API**. Enable **Google Analytics Admin API** as well to read the property's creation date for historical unique users. If Admin access is unavailable, the dashboard still shows recent activity and explains the missing history.
2. Configure the Google Auth Platform app with audience **External**. Request only `https://www.googleapis.com/auth/analytics.readonly`.
3. Set its publishing status to **In production** before connecting. External apps left in **Testing** receive refresh tokens that expire after seven days for this scope. A personal app used only by its owner or a few known people can use Google's personal-use verification exception; Google may show an unverified-app notice. [Token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [personal-use exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification#exceptions)
4. Create an OAuth client of type **Web application**. Register this exact authorized redirect URI:

   ```text
   http://127.0.0.1:53682/oauth/callback
   ```

   `localhost`, another port, and a trailing slash are different URIs. The helper uses this fixed loopback address and does not require a JavaScript origin.
5. Download the client JSON. Keep it outside tracked source files, such as in Downloads. The helper accepts the downloaded `web` client format and ignores endpoint URLs supplied in that file.

## Authorize once and verify the property

From the repository's `diagnostics` directory, using Node 24 or newer:

```powershell
node tools/connect-ga4.mjs --client "C:\path\to\downloaded-client.json" --output .wrangler/ga4-credentials.json
```

Open the authorization URL printed by the helper. Choose the account that can already view property 547084285 and approve the read-only Analytics permission. The local callback waits up to five minutes. Return to the terminal after the browser confirms receipt.

The helper uses a random state value and PKCE, accepts one valid loopback callback, and exchanges the code directly with Google. It verifies access through a realtime report before writing anything. It prints no authorization code, client secret, access token, or refresh token. [Google's OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server)

On success, `.wrangler/ga4-credentials.json` contains a Wrangler bulk-secret object with the single `GA4_OAUTH_CREDENTIALS` key. Its value is a JSON string containing the client ID, client secret, and refresh token. `.wrangler` is already ignored by Git. The helper refuses an output path outside this directory or an existing output file.

## Install the Worker secret

Use the project's authenticated Wrangler session:

```powershell
npx wrangler secret bulk .wrangler/ga4-credentials.json
```

This updates the deployed Worker's secret. It does not print the secret values. Refresh the private diagnostics dashboard after the command succeeds. [Wrangler secret commands](https://developers.cloudflare.com/workers/wrangler/commands/)

The Worker refreshes short-lived access tokens as needed. Google consent remains revocable; reconnect if the grant is revoked or expires. To repeat setup, choose a new output filename inside `.wrangler` or remove the old credential file first. Preserve the downloaded client JSON and generated credentials only where you normally keep local secrets.

## Check the displayed meaning

- Realtime: store listing active users in the last 30 minutes.
- Weekly: active users over the last seven completed days, compared with the preceding seven days.
- Historical: `totalUsers` queried once from the property's creation date through today, in the property's reporting timezone. Daily counts are not added together.
- Missing connection or provider failure: unavailable values, not fabricated zero users. Google can apply thresholding, sampling, or aggregation limits; the dashboard displays quality flags.

If the helper rejects the client file, check the Web application type and exact registered redirect URI. If property verification fails, check the selected Google account and that the Data API is enabled in the client's project. Authorization denial or a five-minute timeout requires a fresh helper run. No credentials are written when authorization or verification fails.
