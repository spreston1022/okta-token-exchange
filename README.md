## Okta Token Exchange MCP Gateway

An MCP Gateway that fronts [`basic-api`](https://basic-api-main-cf106ad.zuplo.app/mcp)
(a Zuplo demo MCP server exposing one tool, `echo-get`, which reflects back
the full incoming request — headers included) with real Okta authentication
on both hops.

> **Current status**: login and ID-JAG *issuance* are verified working
> end-to-end against a real Okta trial and a real deployed gateway — Okta's
> own System Log shows `app.oauth2.token.grant.id_jag | SUCCESS`. The final
> leg (redemption) is blocked by a real gap in `@zuplo/runtime`, not
> anything wrong with this project's Okta configuration. Full trace below,
> after the architecture description.

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
   login (Authorization Code) against Okta's **org** authorization server
   (no `authorizationServerId` set); the gateway issues its own access token
   bound to this route. This same app (`OKTA_GATEWAY_CLIENT_ID`) is also
   registered as an **AI Agent** in Okta (Directory > AI Agents) — that's
   what lets it perform ID-JAG issuance in step 3. (Note the `-inbound`
   suffix on `policyType` — every provider wrapper in
   `@zuplo/runtime/mcp-gateway` uses it, even though the class's own
   `static policyType` field in the shipped `.d.ts` currently documents the
   unsuffixed form. Using the unsuffixed string parses fine but silently
   fails route registration at runtime — surfaces as a baffling
   `Unknown MCP route: /mcp` on every request, with no indication which
   policy caused it.)
2. `tool-rbac` (`mcp-capability-filter-inbound` /
   `McpCapabilityFilterInboundPolicy`, `accessControl.mode: "rolesAndGroups"`)
   — intended to gate `echo-get` behind an Okta role/group named `mcp-user`.
   **Currently fails closed**: the `groups` claim this relies on was added to
   the `default` custom authorization server, but login now has to go
   through the org AS instead (see step 1) to make ID-JAG issuance work, and
   the org AS doesn't carry that claim. Net effect: nobody currently passes
   this check. Remove this policy if you want a working (if ungated) tool
   today; re-adding real RBAC needs a claims mechanism compatible with the
   org AS, or a custom policy that checks group membership via the Okta
   Users API directly instead of reading it off the token.
3. `okta-upstream-token-exchange` (`mcp-token-exchange-inbound` /
   `McpTokenExchangeInboundPolicy`, `authMode: "id-jag"`) — the actual token
   exchange. Two legs happen here, both against Okta:
   - **Issue** (`idJag.idp`, verified working): the gateway exchanges the
     caller's Okta ID token for an ID-JAG
     (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
     `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`) at
     Okta's **org** authorization server, authenticating as the same client
     as step 1 — Okta's System Log confirms
     `app.oauth2.token.grant.id_jag | SUCCESS` for this exact call.
   - **Redeem** (`idJag.resourceAs`, **currently blocked**): the gateway
     presents that ID-JAG to a dedicated Resource Authorization Server
     representing `basic-api`
     (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`). This fails
     on every attempt with Okta error `id_jag_scopes_in_request`. Root cause
     (read directly out of `@zuplo/runtime`'s compiled source): the
     redemption request unconditionally includes a `scope` parameter,
     sourced from whatever scope the ID-JAG issuance response granted
     (`basic-api.read` in our case, embedded by Okta automatically —
     independent of what `idJag.scopes` requests, including omitting it
     entirely). Okta's own documented redemption request
     ([Set up AI agent token exchange](https://developer.okta.com/docs/guides/ai-agent-token-exchange/authserver/main/))
     has no `scope` parameter at all — the grant is implied by the assertion
     itself. This is a genuine gap in the runtime, not something
     `policies.json` can work around; it needs a fix on Zuplo's side.

This is Okta's own [AI Agent Token
Exchange](https://developer.okta.com/docs/guides/ai-agent-token-exchange/authserver/main/)
pattern (Cross App Access / ID-JAG, built on the same IETF Identity Assertion
JWT Authorization Grant draft as the two-legged flow above) — a real
three-legged token exchange, not a shared client-credentials secret reused
for every call. It's distinct from — and more capable than — Okta's older
On-Behalf-Of token-exchange grant (which is client-credentials-style and
stamps the acting client into a proprietary `cid` claim rather than a
standards-based `act`).

> **On the "is this an entitlement gap?" question**: no. Verified directly
> against Okta's own developer docs — "Okta for AI Agents" (the paid add-on)
> is only required for higher ID-JAG token *volumes* ("Machine access" tab);
> the base flow this project uses just needs an org with SSO, which any
> trial has. Also checked Okta's Early-Access Features API
> (`/api/v1/features`) for a hidden toggle — nothing related exists there
> either. The remaining blocker (above) is a real code gap, not a
> subscription wall.

### Okta setup required

You need a **free Okta org** for this — either an
[Integrator Free Plan](https://developer.okta.com/docs/reference/org-defaults/)
org (no credit card, deactivates after 90 days of no sign-ins) or a Workforce
Identity trial org. The full, verified setup:

1. **Gateway/agent app** — Applications > Create App Integration > OIDC -
   Web Application. Redirect URI: `https://<gateway-host>/__zuplo/oauth/callback`
   (and `http://localhost:9000/__zuplo/oauth/callback` for local dev).
   → `OKTA_GATEWAY_CLIENT_ID` / `OKTA_GATEWAY_CLIENT_SECRET`. Assign whoever
   should reach the gateway to this app (Applications > this app >
   Assignments) — Okta requires this separately from group membership.
2. **Register it as an AI Agent** — Directory > AI Agents > Register AI
   agent. Profile: any name/description. User access: "Select an existing
   app" → the app from step 1 (not a new one). This auto-adds the
   `token-exchange` and `jwt-bearer` grant types to that app.
3. **Resource authorization server** — Security > API > Authorization
   Servers > Add Authorization Server, representing `basic-api`. Add a
   `basic-api.read` scope. Note its Audience value (this is
   `OKTA_RESOURCE_AS_AUDIENCE` — not the `basic-api` URL itself) and its
   token endpoint (`OKTA_RESOURCE_AS_TOKEN_URL`).
4. **Resource app + Cross App Access** — create another OIDC app
   representing the resource (a "Resource server" style app works), enable
   **Cross App Access (XAA)** on it (Applications > this app > Sign On >
   Access Methods > Cross-app access (XAA) > Enabled), with **Issuer URL**
   set to the authorization server from step 3's issuer.
5. **Resource redemption app** — a separate API Services app, client
   authentication = public/private key (`private_key_jwt` — XAA requires a
   signed client assertion here, not a plain secret), authorized for the
   `urn:ietf:params:oauth:grant-type:jwt-bearer` grant type on the
   authorization server from step 3 (Access Policies there, scoped to this
   app's client). → `OKTA_RESOURCE_CLIENT_ID` / `OKTA_RESOURCE_PRIVATE_KEY_PEM`.
6. **Resource connection** — Directory > AI Agents > [your agent] > Resource
   connections > Add resource connection. Application instance: the resource
   app from step 4. Resource indicator: the actual MCP server URL
   (`UPSTREAM_BASIC_API_MCP_URL`). "AI agent's client ID registered in this
   app": the redemption app's client ID from step 5. Scopes: any.
7. **Assign the test user to the resource app too** (step 4's app,
   Applications > Assignments) — easy to miss, and without it the flow fails
   the same way as a missing resource connection would.
8. **Add a grant-type access policy rule on Okta's `default` authorization
   server** for the gateway/agent app's client (step 1), allowing
   `urn:ietf:params:oauth:grant-type:token-exchange` — this turned out *not*
   to be load-bearing for the working org-AS flow, but was added during
   diagnosis and left in place; harmless either way.

Copy `.env.example` to your Zuplo project's environment configuration and
fill in the values (secrets in the secret store, not committed — every
comment in that file says exactly which setup step above it corresponds to,
and flags the one leg that's currently blocked).

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
