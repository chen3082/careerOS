# Google sign-in

CareerOS uses Google Identity Services' official button and server-side ID token verification. Direct sign-in needs a Web OAuth **Client ID only**, no client secret. It does not use Identity Platform, request Gmail/Calendar scopes, or alter MCP authorization.

## Operator setup

1. In Google Cloud Console → Google Auth Platform → Clients, choose an existing appropriate **Web application** client or create a dedicated CareerOS client. Do not replace another app's settings.
2. Authorized JavaScript origin: `https://gptig.allenchencode.com` (scheme + host; no `/careeros` path). For local development, add the actual local origin separately to a development client. This popup callback integration does not require an OAuth redirect URI.
3. Configure branding, support contact and audience for the intended users. Home page: `https://gptig.allenchencode.com/careeros/`; privacy policy: `https://gptig.allenchencode.com/careeros/privacy`. Only basic identity (openid, email, profile) is involved. Follow any Console domain/brand verification requirements before public launch.
4. Set `GOOGLE_LOGIN_CLIENT_ID` in the private CareerOS deployment `.env`. This variable is intentionally separate from the Gmail/Calendar connector's `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Restart only the CareerOS web container (`docker-compose up -d --no-deps web`). Verify the official Google button, successful Google login, explicit linking, logout and reauthentication against the real configured origin. Synthetic tests do not prove Google Console configuration.

Absent configuration, password login remains available and the Google login button is hidden. Existing users must sign in with their password and link Google in Settings; matching emails are never silently merged. New Google users require the same invite/bootstrap policy as password registration. Use the stable verified Google `sub` as identity.

## Security and testing

RS256 JWT signature, Google issuer, exact audience/authorized party, verified email, issued/expiry times, and one-time browser nonce are checked. The test key resolver is constructor-injected only with `NODE_ENV=test`; production always uses Google's fixed HTTPS JWKS endpoint. Challenges expire in five minutes and are bound to an HttpOnly SameSite cookie; link/reauth also bind the original session. Completed challenge records temporarily retain a session hash so a concurrent logout can revoke an in-flight login result.

Passwordless accounts must reauthenticate with Google within five minutes before setting a password or deleting data. Linking requires the current CareerOS password. Unlink/password changes revoke sessions, pending Google challenges, MCP tokens and unspent authorization codes. Token issuance and revocation lock the same owner row.

Integration tests use generated RSA keys and the production verifier, never real Google credentials. Browser tests replace only the external GIS widget with a synthetic callback and exercise the real application API, cookies, database and UI. Run through `scripts/test-mcp-e2e.sh` with `CAREEROS_E2E_SCENARIO=google` for a disposable database/network, no production mounts, resource caps, and comparison of all existing services before and after.

Official references: [Google setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), [server verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
