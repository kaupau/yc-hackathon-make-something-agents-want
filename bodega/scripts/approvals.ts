// Trusted local operator utility. Never expose this token-bearing output as an agent tool.
const url = process.env.BODEGA_PUBLIC_URL ?? "http://127.0.0.1:8787";
const token = process.env.BODEGA_VENDOR_ADMIN_TOKEN;
if (!token)
  throw new Error("Set BODEGA_VENDOR_ADMIN_TOKEN in the private .env file");
const result = await fetch(new URL("/admin/approvals", url), {
  headers: { authorization: `Bearer ${token}` },
});
if (!result.ok) throw new Error("Administrator inbox unavailable");
const data = await result.json();
console.log(JSON.stringify(data.pending, null, 2));
export {};
