import { choice, image, noul, TypeSafeClient, withAssets } from "@typesafe-ai/sdk";
import sharp from "sharp";
import type { Listing } from "./types.js";

/**
 * Jev (TypeSafe System One) supplies the judgments code cannot make: is this listing the
 * product the agent asked for, and are two listings the same item. Typed probabilities,
 * no generated text, batched where the state is shared.
 */
let client: TypeSafeClient | null = null;
const jev = () => (client ??= new TypeSafeClient({ defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" } }));
export const jevAvailable = () => !!process.env.TYPESAFE_API_KEY;

const slim = (l: Listing) => ({ marketplace: l.marketplace, title: l.title, price_usd: l.price_usd, condition: l.condition, size: l.size ?? null, brand: l.brand ?? null });

/** Per listing: P(it is the product the query names, not an accessory/part/other model). */
export async function relevance(query: string, listings: Listing[]): Promise<number[]> {
  if (!jevAvailable() || listings.length === 0) return listings.map(() => 1);
  return Promise.all(listings.map(async (l) => {
    const { answers } = await jev().systemOne({
      state: { query, listing: slim(l) },
      questions: {
        same_product: noul("Is `listing` an offer for the exact product named in `query` (same model line), rather than an accessory, a part, a different model, or a lookalike?", { true: "The listing is the product the query names", false: "Accessory, part, different model, bundle of something else, or unclear" }),
      },
    });
    return answers.same_product.noul;
  }));
}

/** Pairwise: P(two listings are the same item spec), used before quoting a spread. */
export async function sameItem(a: Listing, b: Listing): Promise<number> {
  if (!jevAvailable()) return 1;
  const { answers } = await jev().systemOne({
    state: { a: slim(a), b: slim(b) },
    questions: { same: noul("Do `a` and `b` describe the same product (same brand, model and generation), ignoring price, condition and seller?") },
  });
  return answers.same.noul;
}

/**
 * Fetch a listing photo and normalize it for Jev: PNG/JPEG only, each side 280..1568 px,
 * never resized by the API (an out-of-range image fails the whole request). sharp handles
 * WebP/HEIC input, EXIF rotation, up/down-scaling and baseline JPEG output.
 */
async function photo(url: string | null | undefined) {
  if (!url) return null;
  try {
    // Amazon search thumbnails are ~160 px; the same key serves a 1000 px variant
    const u = url.replace(/\._AC_[A-Z0-9_,]+_\.jpg$/, "._AC_SL1000_.jpg");
    const r = await fetch(u, { headers: { accept: "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1" } });
    if (!r.ok) return null;
    const src = Buffer.from(await r.arrayBuffer());
    if (src.length < 1000 || src.length > 12_000_000) return null;
    let img = sharp(src).rotate();
    const meta = await img.metadata(); const w = meta.width ?? 0, h = meta.height ?? 0;
    if (!w || !h) return null;
    const MAX = 1200, MIN = 300;
    if (Math.max(w, h) > MAX) img = img.resize({ width: MAX, height: MAX, fit: "inside" });
    else if (Math.min(w, h) < MIN) { const f = MIN / Math.min(w, h); img = img.resize({ width: Math.min(MAX, Math.round(w * f)), height: Math.min(MAX, Math.round(h * f)), fit: "fill" }); }
    const out = await img.flatten({ background: "#ffffff" }).jpeg({ quality: 88, progressive: false }).toBuffer();
    return image(new Blob([new Uint8Array(out)], { type: "image/jpeg" }));
  } catch { return null; }
}

/** Multimodal: P(the two listing photos show the same product model). null when a photo is unavailable. */
export async function samePhoto(a: Listing, b: Listing): Promise<number | null> {
  if (!jevAvailable()) return null;
  const [pa, pb] = await Promise.all([photo(a.image), photo(b.image)]);
  if (!pa || !pb) return null;
  try {
  const { answers } = await jev().systemOne({
    state: withAssets`Listing A (${a.marketplace}): "${a.title}". Photo: ${pa}. Listing B (${b.marketplace}): "${b.title}". Photo: ${pb}.`,
    questions: { same: noul(withAssets`Do ${pa} and ${pb} show the same product model (same garment design, brand and type), ignoring colour, background and photo quality?`) },
  });
  return answers.same.noul;
  } catch (e: any) { lastPhotoError = e.message?.split("\n")[0]; return null; }
}
export let lastPhotoError: string | undefined;

export type CatchReason = "read_description" | "damage_or_wear" | "parts_or_incomplete" | "replica_or_authenticity" | "size_or_variant" | "none";
/** P(the listing text signals a catch) plus the most likely kind of catch, in one request. */
export async function catchRisk(l: Listing): Promise<{ risk: number; reason: CatchReason }> {
  if (!jevAvailable()) return { risk: 0, reason: "none" };
  const { answers } = await jev().systemOne({
    state: { listing: slim(l) },
    questions: {
      risk: noul("Does `listing` signal a catch for a buyer: damage, defects, stains, missing parts, 'read description', replica/fake, parts only, or that it is not the complete product?", { true: "A warning sign is present in the title or condition", false: "Nothing in the text suggests a problem" }),
      reason: choice("What is the most likely catch in `listing`, if any?", { read_description: "Title asks to read the description or says 'as is'", damage_or_wear: "Damage, defects, stains, heavy wear, repairs needed", parts_or_incomplete: "Parts only, missing pieces, box or accessories only", replica_or_authenticity: "Replica, unbranded, 'style', or authenticity in doubt", size_or_variant: "Kids, youth, mini or a different variant than the query", none: "Nothing suggests a catch" }),
    },
  });
  return { risk: answers.risk.noul, reason: answers.reason.choice as CatchReason };
}
