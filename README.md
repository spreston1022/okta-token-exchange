## Okta Token Exchange MCP Gateway

An MCP Gateway that fronts [`basic-api`](https://basic-api-main-cf106ad.zuplo.app/mcp)
(a Zuplo demo MCP server exposing one tool, `echo-get`, which reflects back
the full incoming request — headers included) with real Okta authentication
on both hops:

- **Inbound**: MCP clients (Claude Desktop, Claude Code, Cursor, MCP
  Inspector, ...) authenticate via Okta browser login. The gateway issues its
  own access token to the client; it never hands out a raw Okta token.
- **Upstream**: rather than a shared static credential, the gateway
  exchanges the caller's Okta identity for a downstream-scoped access token
  — Okta's On-Behalf-Of / ID-JAG token exchange (built on
  [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)) — and attaches *that*
  token to the call it forwards to `basic-api`. Because `echo-get` reflects
  request headers back verbatim, you can see the exchanged token land in the
  response's `headers.authorization` and confirm the exchange actually
  happened.

**One route, three policies, in order** (`config/routes.oas.json` /
`config/policies.json`):

1. `okta-inbound-oauth` (`mcp-okta-oauth-inbound` /
   `McpOktaOAuthInboundPolicy`) — sends the caller through Okta's browser
   login (Authorization Code) against the `default` custom authorization
   server; the gateway issues its own access token bound to this route.
   (Note the `-inbound` suffix on `policyType` — every provider wrapper in
   `@zuplo/runtime/mcp-gateway` uses it, even though the class's own
   `static policyType` field in the shipped `.d.ts` currently documents the
   unsuffixed form. Using the unsuffixed string parses fine but silently
   fails route registration at runtime — surfaces as a baffling
   `Unknown MCP route: /mcp` on every request, with no indication which
   policy caused it.)
2. `tool-rbac` (`mcp-capability-filter-inbound` /
   `McpCapabilityFilterInboundPolicy`, `accessControl.mode: "rolesAndGroups"`)
   — only callers whose Okta role/group includes `mcp-user` see or can call
   `echo-get`; everyone else gets it filtered out of `tools/list` and blocked
   at invocation. Remove this policy (or widen the role) if you don't need
   per-tool gating yet — with one tool and a small test org it's optional.
3. `okta-upstream-token-exchange` (`mcp-token-exchange-inbound` /
   `McpTokenExchangeInboundPolicy`, `authMode: "id-jag"`) — the actual token
   exchange. Two legs happen here, both against Okta:
   - **Issue**: the gateway exchanges the caller's Okta identity assertion
     for an ID-JAG (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
     `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`) at
     Okta's org authorization server.
   - **Redeem**: the gateway presents that ID-JAG to a dedicated Resource
     Authorization Server representing `basic-api`
     (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`), which
     returns an access token scoped to `basic-api.read`. That token is
     attached as the outbound `Authorization` header before the request is
     forwarded to `basic-api-main-cf106ad.zuplo.app/mcp`.

This is Okta's own [AI Agent Token
Exchange](https://developer.okta.com/docs/guides/ai-agent-token-exchange/authserver/main/)
pattern (Cross App Access / ID-JAG, built on the same IETF Identity Assertion
JWT Authorization Grant draft as the two-legged flow above) — a real
three-legged token exchange, not a shared client-credentials secret reused
for every call. It's distinct from — and more capable than — Okta's older
On-Behalf-Of token-exchange grant (which is client-credentials-style and
stamps the acting client into a proprietary `cid` claim rather than a
standards-based `act`).

> **Availability note**: Cross App Access / Agent SSO is a young Okta
> feature (GA'd 2026-08-24). A 30-day Workforce Identity **trial** org
> typically unlocks premium add-ons like this one for evaluation, so it
> should be available — but it's worth confirming before wiring in real
> credentials, since the perpetual (non-trial) Integrator Free Plan may not
> include it. Okta's hosted playground at [xaa.dev](https://xaa.dev) lets you
> validate this project's exact `idp`/`resourceAs` shape against a pre-wired
> IdP + Resource AS with zero tenant setup, before touching your own org. If
> your trial genuinely doesn't expose Cross App Access (check Security > API
> for a Cross App Access / Agent SSO section, or ask Okta support), the only
> fallback that's still a literal token exchange is a hand-written Zuplo
> policy performing Okta's older On-Behalf-Of grant directly — `shared-oauth`
> / `user-oauth` `authMode`s are plain OAuth brokering, not token exchange,
> so they're not a drop-in substitute if that distinction matters to you.

### Okta setup required

You need a **free Okta org** for this — either an
[Integrator Free Plan](https://developer.okta.com/docs/reference/org-defaults/)
org (no credit card, deactivates after 90 days of no sign-ins) or a Workforce
Identity trial org. Both ship with a pre-configured `default` custom
authorization server, reused below for both the browser-login and ID-JAG
legs; a second, dedicated one is created for the resource leg.

1. **Gateway login app** — Applications > Create App Integration > OIDC -
   Web Application. Redirect URI: `https://<gateway-host>/__zuplo/oauth/callback`
   (and `http://localhost:9000/__zuplo/oauth/callback` for local dev). This
   is identity-only; no API/audience needed. → `OKTA_GATEWAY_CLIENT_ID` /
   `OKTA_GATEWAY_CLIENT_SECRET`.
2. **ID-JAG issuer app** — Applications > Create App Integration > API
   Services. Set **client authentication** to public key/private key (Cross
   App Access requires a signed `private_key_jwt` client assertion, not a
   plain client secret) and generate/upload a key pair. On the `default`
   authorization server's Access Policies (Security > API > Authorization
   Servers > `default`), add a rule granting this app's client the
   `urn:ietf:params:oauth:grant-type:token-exchange` grant type.
   → `OKTA_IDJAG_CLIENT_ID` / `OKTA_IDJAG_PRIVATE_KEY_PEM`,
   `OKTA_IDJAG_TOKEN_URL=https://${OKTA_DOMAIN}/oauth2/default/v1/token`.
3. **Resource authorization server** — Security > API > Authorization
   Servers > Add Authorization Server, representing `basic-api`. Add a
   `basic-api.read` scope. Note its Audience value (this is
   `OKTA_RESOURCE_AS_AUDIENCE` — not the `basic-api` URL itself) and its
   token endpoint (`OKTA_RESOURCE_AS_TOKEN_URL`).
4. **Resource redemption app** — another API Services app (or the same one
   from step 2, given an access policy on this new authorization server too),
   same private-key client authentication, authorized for the
   `urn:ietf:params:oauth:grant-type:jwt-bearer` grant type on the
   authorization server from step 3. → `OKTA_RESOURCE_CLIENT_ID` /
   `OKTA_RESOURCE_PRIVATE_KEY_PEM`.
5. **Role/group for RBAC** — create an Okta group (or app role) named
   `mcp-user`, assign it to whoever should be able to call `echo-get`, and
   make sure the authorization server used for browser login includes a
   `roles` or `groups` claim on the access token sourced from it (Security >
   API > Authorization Servers > [server] > Claims).

Copy `.env.example` to your Zuplo project's environment configuration and
fill in the values (secrets in the secret store, not committed — every
comment in that file says exactly which setup step above it corresponds to).

**Status on the Okta trial org this was tested against** — steps 1–5's *objects* (apps, the
`basic-api` authorization server + scope, the `mcp-user` group + its
membership and claim) are already provisioned there via the Management API,
and `.env` (gitignored, not committed) already has every value filled in.
Two sub-steps remain — the actual grant-type-enabling policy rules on the
shared `default` authorization server (step 2's `token-exchange` grant and,
on `default` specifically, the rule wiring for the gateway login app's
`authorization_code` grant) — these touch the org-wide `default` server, so
they're left for you to add by hand (or approve explicitly) rather than
scripted blind: Security > API > Authorization Servers > `default` > Access
Policies. The private keys for the two service apps live locally at
`~/.okta/secrets/{idjag-issuer,resource-redeemer}.pem` (gitignored, not
committed) — the corresponding public JWKs are already uploaded to their
Okta apps.

### Testing

Use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`) against `http://localhost:9000/mcp`
with transport type "Streamable HTTP" — it will pop the Okta login page on
first connect — or point a real MCP client (Claude Desktop, Claude Code) at
the same URL. Call `echo-get` and check the response's
`headers.authorization`: that's the token minted by the Okta ID-JAG exchange,
not anything the client presented to the gateway.

**Local-dev limitation**: `zuplo dev` can serve `/mcp` and its
`.well-known/oauth-*` metadata (enough to confirm routing/policy config is
valid), but the actual OAuth flows (`/__zuplo/oauth/register`, `/authorize`,
`/token`) need durable storage for client registrations and token state that
only exists once this project is deployed to Zuplo (`MCP Gateway runtime
storage requires ZUPLO_SERVICE_BUCKET_ID` locally) — a real end-to-end login
needs a deployed URL, not `localhost:9000`. Separately, `zuplo.jsonc`'s
`compatibilityDate` is set to `2026-03-01`, matching MCP Gateway v2's stated
requirement and the known-working reference project — the
`create-zuplo-api` scaffold's original (older) default hadn't been bumped;
worth keeping in mind if this ever gets reset, though it wasn't the cause of
the `Unknown MCP route` bug above (that reproduced identically regardless of
this date once real Okta values were in place — it was purely the
policyType suffix).

---

This is a Zuplo API that was created with
[`create-zuplo-api`](https://zuplo.com/docs).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:9000](http://localhost:9000) with your browser to see the
result.

You can start editing the API by modifying `config/routes.oas.json`. The dev
server will automatically reload the API with your changes.

## Debugging

In VS Code, open **Run and Debug**, select **Launch & Attach Zuplo**, and click
the green play button.

For other editors and more details, see the
[debugging guide](https://zuplo.com/docs/articles/local-development-debugging).

## Learn More

To learn more about Zuplo, you can visit the
[Zuplo documentation](https://zuplo.com/docs).

To connect with the community join [Discord](https://discord.zuplo.com).
