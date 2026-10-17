import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { adapters } from "./adapters/index.js";
import { makeGenericAdapter, type GenericConfig } from "./adapters/generic.js";

const FILE = ".cache/marketplaces.json";

export function loadRegistry() {
  let cfgs: GenericConfig[] = [];
  try { cfgs = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  for (const c of cfgs) adapters[c.name] = makeGenericAdapter(c);
  return cfgs;
}

export function register(cfg: GenericConfig) {
  adapters[cfg.name] = makeGenericAdapter(cfg);
  let cfgs: GenericConfig[] = [];
  try { cfgs = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  cfgs = cfgs.filter((c) => c.name !== cfg.name).concat(cfg);
  mkdirSync(".cache", { recursive: true }); writeFileSync(FILE, JSON.stringify(cfgs, null, 1));
}
