import { createApplication } from "./server.js";
const host = process.env.HOST ?? "127.0.0.1";
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  (!process.env.BODEGA_AGENT_TOKEN ||
    process.env.BODEGA_AGENT_TOKEN.length < 24)
)
  throw new Error(
    "Non-loopback binding requires BODEGA_AGENT_TOKEN of at least 24 characters",
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
