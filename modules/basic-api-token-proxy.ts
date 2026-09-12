import { environment, type ZuploContext, type ZuploRequest } from "@zuplo/runtime";

/**
 * Sits between @zuplo/runtime's mcp-token-exchange-inbound policy (id-jag
 * mode, redemption leg) and Okta's real `basic-api` resource-authorization-
 * server token endpoint.
 *
 * The runtime unconditionally includes a `scope` form parameter on the
 * jwt-bearer redemption request, sourced from whatever scope Okta's own
 * ID-JAG issuance response granted — regardless of what (if anything)
 * `idJag.scopes` in policies.json requests, including omitting it entirely.
 * Okta's documented redemption request has no `scope` parameter at all (the
 * grant is implied by the `assertion` itself), and rejects ours with
 * `id_jag_scopes_in_request` every time.
 *
 * This route is what `OKTA_RESOURCE_AS_TOKEN_URL` actually points at now —
 * it strips `scope` from the incoming form body and forwards everything
 * else, unmodified, to the real Okta token endpoint (`REAL_OKTA_RESOURCE_AS_TOKEN_URL`),
 * then relays Okta's response back verbatim.
 */
export default async function (request: ZuploRequest, context: ZuploContext) {
  const realTokenUrl = environment.REAL_OKTA_RESOURCE_AS_TOKEN_URL;
  if (!realTokenUrl) {
    return new Response(
      JSON.stringify({
        error: "server_error",
        error_description:
          "REAL_OKTA_RESOURCE_AS_TOKEN_URL is not set on this deployment.",
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    // Not the shape we expect from the runtime's redemption call — pass
    // through unmodified rather than guess.
    return fetch(realTokenUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : await request.text(),
    });
  }

  const bodyText = await request.text();
  const params = new URLSearchParams(bodyText);
  const hadScope = params.has("scope");
  params.delete("scope");

  context.log.info(
    `basic-api-token-proxy: forwarding jwt-bearer redemption to Okta${
      hadScope ? " (stripped 'scope' param)" : " (no 'scope' param present)"
    }`,
  );

  const upstreamResponse = await fetch(realTokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const responseBody = await upstreamResponse.text();
  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: {
      "content-type":
        upstreamResponse.headers.get("content-type") ?? "application/json",
    },
  });
}
