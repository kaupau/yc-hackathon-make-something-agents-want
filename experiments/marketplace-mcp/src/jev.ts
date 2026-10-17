import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
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
