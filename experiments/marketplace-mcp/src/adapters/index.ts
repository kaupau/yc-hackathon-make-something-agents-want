import type { Adapter } from "../types.js";
import { amazon } from "./amazon.js";
import { ebay } from "./ebay.js";
import { grailed } from "./grailed.js";

export const adapters: Record<string, Adapter> = { ebay, grailed, amazon };
export const marketplaces = () => Object.keys(adapters);
