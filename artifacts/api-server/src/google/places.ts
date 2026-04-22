export interface PlaceResult {
  name: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  address?: string;
  primaryType?: string;
}

export async function searchRestaurants(
  cuisineOrQuery: string,
  city: string,
  maxResults = 5
): Promise<PlaceResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn("[Places] GOOGLE_PLACES_API_KEY not set — skipping live restaurant search");
    return [];
  }

  const textQuery = cuisineOrQuery.toLowerCase() === "restaurant"
    ? `best restaurants in ${city}`
    : `${cuisineOrQuery} restaurants in ${city}`;

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.displayName",
          "places.rating",
          "places.userRatingCount",
          "places.priceLevel",
          "places.formattedAddress",
          "places.primaryTypeDisplayName",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery,
        maxResultCount: maxResults,
        languageCode: "en",
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[Places] API error ${res.status}: ${err.slice(0, 200)}`);
      return [];
    }

    const data = (await res.json()) as {
      places?: Array<{
        displayName?: { text: string };
        rating?: number;
        userRatingCount?: number;
        priceLevel?: string;
        formattedAddress?: string;
        primaryTypeDisplayName?: { text: string };
      }>;
    };

    return (data.places ?? []).map((p) => ({
      name: p.displayName?.text ?? "Unknown",
      rating: p.rating,
      userRatingCount: p.userRatingCount,
      priceLevel: p.priceLevel,
      address: p.formattedAddress,
      primaryType: p.primaryTypeDisplayName?.text,
    }));
  } catch (err) {
    console.error("[Places] Search failed:", err);
    return [];
  }
}

export function extractCuisineFromMessage(message: string): string {
  const cuisines = [
    "italian", "mexican", "japanese", "sushi", "thai", "indian", "chinese",
    "french", "greek", "korean", "vietnamese", "mediterranean", "american",
    "bbq", "barbecue", "steakhouse", "steak", "seafood", "pizza", "burger",
    "tex-mex", "ramen", "ethiopian", "middle eastern", "lebanese", "persian",
    "turkish", "spanish", "tapas", "dim sum", "brunch", "breakfast",
  ];
  const lower = message.toLowerCase();
  for (const cuisine of cuisines) {
    if (lower.includes(cuisine)) return cuisine;
  }
  return "restaurant";
}

const PRICE_LABEL: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

export function formatPlacesForPrompt(places: PlaceResult[], city: string, cuisine: string): string {
  if (!places.length) return "";

  const label = cuisine === "restaurant" ? `restaurants in ${city}` : `${cuisine} restaurants in ${city}`;

  const lines = places.map((p, i) => {
    const stars = p.rating ? `${p.rating.toFixed(1)}★` : "";
    const votes = p.userRatingCount ? ` (${p.userRatingCount.toLocaleString()} reviews)` : "";
    const price = p.priceLevel ? PRICE_LABEL[p.priceLevel] ?? "" : "";
    const type = p.primaryType && p.primaryType.toLowerCase() !== "restaurant" ? p.primaryType : "";
    const meta = [stars + votes, price, type].filter(Boolean).join(" · ");
    const street = p.address ? p.address.split(",")[0] : "";
    return `${i + 1}. ${p.name}${street ? ` — ${street}` : ""}${meta ? `\n   ${meta}` : ""}`;
  });

  return (
    `\n\n[Google Places — Live Results: ${label}]\n` +
    lines.join("\n") +
    `\n\nUse these live results to make your recommendation. Reference specific names, ratings, and why each fits David's taste based on his profile. Be specific and conversational — don't just list them. Always offer to check availability or pull up a number.`
  );
}
