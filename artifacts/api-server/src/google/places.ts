export interface PlaceResult {
  name: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  address?: string;
  primaryType?: string;
}

export interface NearbyPlaceResult extends PlaceResult {
  openNow?: boolean;
  phoneNumber?: string;
}

// ── Nearby places (pharmacy, hospital, urgent care, etc.) ─────────────────────

const NEARBY_TYPE_MAP: Record<string, string> = {
  pharmacy: "pharmacy",
  drugstore: "pharmacy",
  walgreens: "pharmacy",
  cvs: "pharmacy",
  hospital: "hospital",
  "urgent care": "urgent care clinic",
  urgent_care: "urgent care clinic",
  "urgent care clinic": "urgent care clinic",
  "emergency room": "emergency room",
  grocery: "grocery store",
  supermarket: "grocery store",
  "grocery store": "grocery store",
  groceries: "grocery store",
  "gas station": "gas station",
  gas_station: "gas station",
  gas: "gas station",
  gasoline: "gas station",
  bank: "bank",
  atm: "ATM",
};

export function extractNearbyPlaceType(message: string): string | null {
  const lower = message.toLowerCase();
  for (const [keyword, placeType] of Object.entries(NEARBY_TYPE_MAP)) {
    if (lower.includes(keyword)) return placeType;
  }
  return null;
}

export async function searchNearbyPlaces(
  placeType: string,
  city: string,
  maxResults = 3
): Promise<NearbyPlaceResult[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn("[Places] GOOGLE_PLACES_API_KEY not set — skipping nearby search");
    return [];
  }

  const textQuery = `${placeType} near ${city}`;

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
          "places.formattedAddress",
          "places.primaryTypeDisplayName",
          "places.currentOpeningHours",
          "places.nationalPhoneNumber",
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
      console.error(`[Places] Nearby search error ${res.status}: ${err.slice(0, 200)}`);
      return [];
    }

    const data = (await res.json()) as {
      places?: Array<{
        displayName?: { text: string };
        rating?: number;
        userRatingCount?: number;
        formattedAddress?: string;
        primaryTypeDisplayName?: { text: string };
        currentOpeningHours?: { openNow?: boolean };
        nationalPhoneNumber?: string;
      }>;
    };

    return (data.places ?? []).map((p) => ({
      name: p.displayName?.text ?? "Unknown",
      rating: p.rating,
      userRatingCount: p.userRatingCount,
      address: p.formattedAddress,
      primaryType: p.primaryTypeDisplayName?.text,
      openNow: p.currentOpeningHours?.openNow,
      phoneNumber: p.nationalPhoneNumber,
    }));
  } catch (err) {
    console.error("[Places] Nearby search failed:", err);
    return [];
  }
}

export function formatNearbyPlacesForPrompt(
  places: NearbyPlaceResult[],
  placeType: string,
  city: string
): string {
  if (!places.length) return "";

  const lines = places.map((p, i) => {
    const stars = p.rating ? `${p.rating.toFixed(1)}★` : "";
    const votes = p.userRatingCount
      ? ` (${p.userRatingCount.toLocaleString()} reviews)`
      : "";
    const open =
      p.openNow === true
        ? "Open now"
        : p.openNow === false
        ? "Closed now"
        : "";
    const phone = p.phoneNumber ? `📞 ${p.phoneNumber}` : "";
    const street = p.address ? p.address.split(",").slice(0, 2).join(", ") : "";
    const meta = [stars + votes, open, phone].filter(Boolean).join(" · ");
    return (
      `${i + 1}. ${p.name}${street ? ` — ${street}` : ""}` +
      (meta ? `\n   ${meta}` : "")
    );
  });

  return (
    `\n\n[Google Places — Live Results: ${placeType} near ${city}]\n` +
    lines.join("\n") +
    `\n\nShare these results naturally — name, address, and whether it's open if known. ` +
    `Offer the phone number if available. Keep it conversational.`
  );
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
    `\n\nUse these live results to make your recommendation. Reference specific names, ratings, and why each fits the user's taste based on their profile. Be specific and conversational — don't just list them. Always offer to check availability or pull up a number.`
  );
}
