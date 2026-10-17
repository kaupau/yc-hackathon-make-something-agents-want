// Trusted operator utility for customer provisioning. Never expose it as an agent tool.
// The one-time agent configuration is printed to stdout only; redirect it to a private file.
//   npm run customers -- list
//   npm run customers -- create --email human@example.com --cap 1000 --threshold 100 [--id acme] [--ttl-days 90]
//   npm run customers -- rotate <customer-id> [--ttl-days 90]
//   npm run customers -- issue <customer-id> [--ttl-days 90]
//   npm run customers -- revoke <credential-id>
//   npm run customers -- disable|enable <customer-id>
const url = process.env.BODEGA_PUBLIC_URL ?? "http://127.0.0.1:8787";
const token = process.env.BODEGA_VENDOR_ADMIN_TOKEN;
if (!token) throw new Error("Set BODEGA_VENDOR_ADMIN_TOKEN in the private .env file");
const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++)
  if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[++i] ?? "");
  else positional.push(rest[i]);
const int = (name: string) => {
  const v = flags.get(name);
  return v === undefined ? undefined : Number(v);
};
async function api(path: string, body?: unknown) {
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${data.error ?? "unknown"}`);
  return data;
}
const id = positional[0] ?? "";
const enc = encodeURIComponent;
let result: unknown;
switch (command) {
  case "list":
    result = await api("/admin/customers");
    break;
  case "create":
    result = await api("/admin/customers", {
      ...(flags.has("id") ? { id: flags.get("id") } : {}),
      email: flags.get("email"),
      cap_cents: int("cap"),
      threshold_cents: int("threshold"),
      ...(flags.has("ttl-days") ? { token_ttl_days: int("ttl-days") } : {}),
    });
    break;
  case "rotate":
  case "issue":
    result = await api(`/admin/customers/${enc(id)}/credentials`, {
      revoke_existing: command === "rotate",
      ...(flags.has("ttl-days") ? { token_ttl_days: int("ttl-days") } : {}),
    });
    break;
  case "revoke":
    result = await api(`/admin/credentials/${enc(id)}/revoke`, {});
    break;
  case "disable":
  case "enable":
    result = await api(`/admin/customers/${enc(id)}/active`, { active: command === "enable" });
    break;
  default:
    throw new Error("Usage: customers list|create|rotate|issue|revoke|disable|enable (see script header)");
}
console.log(JSON.stringify(result, null, 2));
export {};
