import { createApplication } from "./server.js";
const host = process.env.HOST ?? "127.0.0.1";
const legacyToken = process.env.BODEGA_AGENT_TOKEN;
// Per-customer credentials are mandatory with the InsForge identity backend or
// BODEGA_REQUIRE_AGENT_AUTH=1; otherwise a strong legacy token is required.
const credentialsRequired =
  process.env.BODEGA_IDENTITY_BACKEND === "insforge" ||
  process.env.BODEGA_REQUIRE_AGENT_AUTH === "1";
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  (legacyToken ? legacyToken.length < 24 : !credentialsRequired)
)
  throw new Error(
    "Non-loopback binding requires BODEGA_AGENT_TOKEN of at least 24 characters or per-customer agent credentials (BODEGA_REQUIRE_AGENT_AUTH=1)",
  );
const application = await createApplication();
const server = application.app.listen(
  Number(process.env.PORT ?? 8787),
  host,
  () =>
    console.log(
      `Bodega listening on http://${host}:${process.env.PORT ?? 8787}; runtime=${application.runtime.backend.mode}; payments=${application.storefront.payments.mode}`,
    ),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      void application.close().then(() => process.exit(0));
    });
    server.closeIdleConnections();
  });
