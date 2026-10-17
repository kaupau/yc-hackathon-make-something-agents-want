import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { adapters } from "./adapters/index.js";
import { makeGenericAdapter, type GenericConfig } from "./adapters/generic.js";

const FILE = ".cache/marketplaces.json";

/** Verified by add_marketplace on 2026-10-17; baked in so a fresh container has them without the cache file. */
export const BUILTIN: GenericConfig[] = [
  { name: "poshmark", template: "https://poshmark.com/search?query={q}", sold_template: "https://poshmark.com/search?query={q}&availability=sold_out", item_prefix: "/listing/", origin: "https://poshmark.com", added_at: "2026-10-17T20:40:00Z", sample_count: 48 },
  { name: "mercari", template: "https://www.mercari.com/search?q={q}", sold_template: "https://www.mercari.com/search/?keyword={q}&itemStatuses=2", item_prefix: "/us/item/", origin: "https://www.mercari.com", added_at: "2026-10-17T20:40:00Z", sample_count: 14 },
  { name: "vinted", template: "https://www.vinted.com/catalog?search_text={q}", item_prefix: "/items/", origin: "https://www.vinted.com", added_at: "2026-10-17T20:40:00Z", sample_count: 95 },
];

export function loadRegistry() {
  let cfgs: GenericConfig[] = [];
  try { cfgs = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  // a cached config from add_marketplace wins on template/prefix, but inherits built-in extras (sold_template) it does not know about
  const all = [...BUILTIN.filter((b) => !cfgs.some((c) => c.name === b.name)), ...cfgs.map((c) => ({ ...(BUILTIN.find((b) => b.name === c.name) ?? {}), ...c }))];
  for (const c of all) adapters[c.name] = makeGenericAdapter(c);
  return all;
}

export function register(cfg: GenericConfig) {
  adapters[cfg.name] = makeGenericAdapter(cfg);
  let cfgs: GenericConfig[] = [];
  try { cfgs = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  cfgs = cfgs.filter((c) => c.name !== cfg.name).concat(cfg);
  mkdirSync(".cache", { recursive: true }); writeFileSync(FILE, JSON.stringify(cfgs, null, 1));
}
