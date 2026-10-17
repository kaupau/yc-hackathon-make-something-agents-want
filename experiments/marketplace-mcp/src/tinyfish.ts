/** TinyFish Fetch API (free tier: 1,000 URLs/day, 150/min). Renders in Chromium server-side; passes eBay's bot check when a cached entry is allowed. */
export interface TFResult { url: string; final_url: string; title: string | null; text: string; links?: string[]; image_links?: string[]; latency_ms: number | null }
export interface TFError { url: string; error: string; status?: number }

export async function tinyfishFetch(urls: string[], opts: { format?: "markdown" | "html" | "json"; links?: boolean; images?: boolean; ttl?: number; purpose?: string } = {}) {
  const key = process.env.TINYFISH_API_KEY;
  if (!key) throw new Error("TINYFISH_API_KEY missing (doppler run -p agents-want -c dev)");
  const body: Record<string, unknown> = { urls, format: opts.format ?? "markdown", links: opts.links ?? false, image_links: opts.images ?? false, per_url_timeout_ms: 60000 };
  if (opts.ttl !== undefined) body.ttl = opts.ttl;
  if (opts.purpose) body.purpose = opts.purpose;
  const r = await fetch("https://api.fetch.tinyfish.ai", { method: "POST", headers: { "X-API-Key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`tinyfish ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { results: TFResult[]; errors: TFError[] };
}
