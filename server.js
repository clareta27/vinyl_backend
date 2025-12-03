// ======================================================
// VINYL BACKEND v1
// Trending + Search + Lookup + Recommend + PriceHistory
// + Smart ChartData Expansion
// ======================================================

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// TOKEN MANAGEMENT
// ======================================================
let accessToken = null;
let accessTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < accessTokenExpiresAt) return accessToken;

  console.log("🔄 Refreshing eBay Access Token...");

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body,
  });

  const data = await resp.json();

  if (!resp.ok || !data.access_token) {
    console.error("❌ Cannot refresh token:", data);
    throw new Error("Cannot refresh token: " + JSON.stringify(data));
  }

  accessToken = data.access_token;
  accessTokenExpiresAt = now + (data.expires_in - 60) * 1000;

  console.log("✅ Token refreshed OK");
  return accessToken;
}

// ======================================================
// MARKETPLACE MAP
// ======================================================
const MARKET_MAP = {
  US: "EBAY_US",
  UK: "EBAY_GB",
  GB: "EBAY_GB",
  CA: "EBAY_CA",
  AU: "EBAY_AU",
  DE: "EBAY_DE",
  FR: "EBAY_FR",
  IT: "EBAY_IT",
  ES: "EBAY_ES",
};

function resolveMarketplace(country = "US") {
  return MARKET_MAP[country.toUpperCase()] || "EBAY_US";
}

// ======================================================
// CACHE MEMORY
// ======================================================
const cacheStore = new Map();
function setCache(key, val, ttlMs) {
  cacheStore.set(key, { val, exp: Date.now() + ttlMs });
}
function getCache(key) {
  const c = cacheStore.get(key);
  if (!c) return null;
  if (Date.now() > c.exp) {
    cacheStore.delete(key);
    return null;
  }
  return c.val;
}

// ======================================================
// VINYL FILTERING
// ======================================================
const BLOCK_WORDS = [
  "poster","print","tshirt","shirt","hoodie","jacket","sticker",
  "figure","funko","toy","magnet","patch","keychain",
  "canvas","digital","template","pdf","ebook","bundle",
  "frame","painting","lamp","furniture","case","phone","iphone",
];

// hanya album, vinyl, cassette, cd, lp
function isVinyl(item) {
  if (!item?.title) return false;
  const t = item.title.toLowerCase();

  if (BLOCK_WORDS.some(w => t.includes(w))) return false;

  return (
    t.includes("vinyl") ||
    t.includes("lp") ||
    t.includes("record") ||
    t.includes("album") ||
    t.includes("cassette") ||
    t.includes("tape") ||
    t.includes("cd") ||
    t.includes("compact disc") ||
    t.includes("limited edition") ||
    t.includes("first press") ||
    t.includes("remaster")
  );
}

// ======================================================
// NORMALIZER
// ======================================================
function normalizeVinyl(item) {
  return {
    itemId: item.itemId,
    title: item.title,
    artist: item.brand || item.title?.split("-")[0]?.trim() || null,
    price: item.price || null,
    image:
      item.thumbnailImages?.[0]?.imageUrl ||
      item.image?.imageUrl ||
      null,
    url: item.itemWebUrl,
    condition: item.condition || null,
  };
}

// ======================================================
// EBAY SEARCH WRAPPER
// ======================================================
async function ebaySearch({ q, country = "US", extra = "" }) {
  const marketplace = resolveMarketplace(country);
  const cacheKey = `V|${marketplace}|${q}|${extra}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const token = await getAccessToken();

  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search` +
    `?q=${encodeURIComponent(q)}` +
    extra;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
      "Content-Type": "application/json",
    },
  });

  const json = await resp.json();

  if (!resp.ok) {
    console.error("❌ eBay Error:", json);
    throw new Error(JSON.stringify(json));
  }

  setCache(cacheKey, json, 5 * 60 * 1000);
  return json;
}

// ======================================================
// 1) /vinyl-trending
// ======================================================
app.get("/vinyl-trending", async (req, res) => {
  try {
    const { country = "US", limit = 40 } = req.query;

    // Artist / genre populer vinyl
    const queries = [
      "pink floyd vinyl",
      "queen vinyl",
      "nirvana vinyl",
      "metallica vinyl",
      "the beatles vinyl",
      "taylor swift vinyl",
      "radiohead vinyl",
      "fleetwood mac vinyl",
      "daft punk vinyl",
      "jazz vinyl",
      "hip hop vinyl",
      "rare cassette tape",
      "vintage cassette",
      "limited edition lp",
    ];

    let found = [];
    for (const q of queries) {
      try {
        const json = await ebaySearch({
          q,
          country,
          extra: "&limit=50&sort=BEST_MATCH",
        });
        found.push(...(json.itemSummaries || []).filter(isVinyl));
      } catch (err) {
        console.warn("⚠ Skip query:", q, "|", err.message);
      }
    }

    const map = new Map();
    for (const it of found) if (!map.has(it.title)) map.set(it.title, it);

    const enriched = [...map.values()].map(it => ({
      ...normalizeVinyl(it),
      score: Number(it.price?.value || 0) + Math.random() * 10,
    }));

    enriched.sort((a, b) => b.score - a.score);

    res.json({
      country,
      total: enriched.length,
      items: enriched.slice(0, Number(limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======================================================
// 2) /vinyl-search
// ======================================================
app.get("/vinyl-search", async (req, res) => {
  try {
    const { q = "", country = "US", page = 1, limit = 20, sort = "best" } =
      req.query;

    const json = await ebaySearch({
      q,
      country,
      extra: "&limit=200",
    });

    let items = (json.itemSummaries || []).filter(isVinyl);

    if (sort === "price_low")
      items.sort((a, b) =>
        Number(a.price?.value || 0) - Number(b.price?.value || 0)
      );

    if (sort === "price_high")
      items.sort((a, b) =>
        Number(b.price?.value || 0) - Number(a.price?.value || 0)
      );

    if (sort === "newest")
      items.sort(
        (a, b) =>
          new Date(b.itemCreationDate || 0) -
          new Date(a.itemCreationDate || 0)
      );

    const start = (Number(page) - 1) * Number(limit);
    const paged = items.slice(start, start + Number(limit));

    res.json({
      country,
      query: q,
      total: items.length,
      items: paged.map(normalizeVinyl),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======================================================
// 3) LOOKUP BARCODE → VINYL
// ======================================================
app.get("/lookup", async (req, res) => {
  try {
    const code = req.query.code;
    const country = req.query.country || "US";

    if (!code)
      return res.status(400).json({ error: "Parameter 'code' wajib diisi" });

    const token = await getAccessToken();
    const marketplace = resolveMarketplace(country);

    // Search via GTIN first
    const url =
      `https://api.ebay.com/buy/browse/v1/item_summary/search` +
      `?gtin=${encodeURIComponent(code)}` +
      "&limit=20";

    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
      },
    });

    const json = await resp.json();
    let items = (json.itemSummaries || []).filter(isVinyl);

    if (items.length === 0) {
      const fallback = await ebaySearch({
        q: code,
        country,
        extra: "&limit=20",
      });
      items = (fallback.itemSummaries || []).filter(isVinyl);
      return res.json({
        code,
        fallback: true,
        total_items: items.length,
        items: items.map(normalizeVinyl),
      });
    }

    res.json({
      code,
      fallback: false,
      total_items: items.length,
      items: items.map(normalizeVinyl),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======================================================
// 4) /recommend (Artist/Album Based)
// ======================================================
app.get("/recommend", async (req, res) => {
  try {
    const { id, country = "US", limit = 20 } = req.query;
    let q = req.query.q || "";

    let baseTitle = "";
    let baseArtist = "";
    let basePrice = 0;

    if (id) {
      const token = await getAccessToken();
      const marketplace = resolveMarketplace(country);

      const detailResp = await fetch(
        `https://api.ebay.com/buy/browse/v1/item/${id}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": marketplace,
          },
        }
      );

      const detailJson = await detailResp.json();

      if (detailResp.ok) {
        baseTitle = detailJson.title || "";
        baseArtist = detailJson.brand || "";
        basePrice = Number(detailJson.price?.value || 0);

        if (!q) q = `${baseArtist} ${baseTitle}`;
      }
    }

    if (!q) q = "vinyl record";

    const raw = await ebaySearch({
      q,
      country,
      extra: "&limit=200",
    });

    let items = (raw.itemSummaries || []).filter(isVinyl);
    if (id) items = items.filter(i => i.itemId !== id);

    const baseWords = baseTitle
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2);

    const recommended = items.map(it => {
      const n = normalizeVinyl(it);
      const priceVal = Number(it.price?.value || 0);

      let score = 0;

      if (
        baseArtist &&
        n.artist &&
        n.artist.toLowerCase() === baseArtist.toLowerCase()
      ) {
        score += 20;
      }

      const diff = Math.abs(priceVal - basePrice);
      score += Math.max(0, 15 - (diff / basePrice) * 20);

      const words = n.title.toLowerCase().split(/\s+/);
      let overlap = 0;
      baseWords.forEach(w => {
        if (words.includes(w)) overlap++;
      });
      score += overlap * 2;

      score += Math.random() * 3;

      return {
        ...n,
        recommend_score: Number(score.toFixed(2)),
      };
    });

    recommended.sort((a, b) => b.recommend_score - a.recommend_score);

    res.json({
      base: {
        id: id || null,
        title: baseTitle,
        artist: baseArtist,
        price: basePrice,
      },
      total_items: recommended.length,
      items: recommended.slice(0, Number(limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======================================================
// 5) PRICE HISTORY
// ======================================================
app.get("/price-history", async (req, res) => {
  try {
    const q = req.query.q;
    const limit = req.query.limit || 30;

    if (!q) return res.status(400).json({ error: "Parameter 'q' wajib diisi" });

    const url =
      "https://svcs.ebay.com/services/search/FindingService/v1?" +
      "OPERATION-NAME=findCompletedItems" +
      "&SERVICE-VERSION=1.13.0" +
      "&RESPONSE-DATA-FORMAT=JSON" +
      `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
      `&keywords=${encodeURIComponent(q)}` +
      "&sortOrder=EndTimeSoonest" +
      `&paginationInput.entriesPerPage=${limit}`;

    const resp = await fetch(url);
    const json = await resp.json();

    const items =
      json?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

    const soldItems = items
      .filter(i => i.sellingStatus?.[0]?.sellingState?.[0] === "EndedWithSales")
      .map(i => {
        const price = Number(
          i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0
        );
        return {
          title: i.title?.[0] || "",
          price,
          url: i.viewItemURL?.[0] || "",
          image: i.galleryURL?.[0] || null,
          condition: i.condition?.[0]?.conditionDisplayName?.[0] || "Unknown",
          endDate: i.listingInfo?.[0]?.endTime?.[0] || null,
        };
      });

    if (soldItems.length === 0) {
      return res.json({
        query: q,
        total_sold: 0,
        items: [],
      });
    }

    const prices = soldItems.map(i => i.price).sort((a, b) => a - b);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    let median;
    if (prices.length % 2 === 0) {
      median = (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
    } else {
      median = prices[Math.floor(prices.length / 2)];
    }

    res.json({
      query: q,
      total_sold: soldItems.length,
      average_price: Number(avg.toFixed(2)),
      lowest_price: prices[0],
      highest_price: prices[prices.length - 1],
      median_price: median,
      items: soldItems,
    });
  } catch (error) {
    console.error("❌ Price history error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ======================================================
// 6) SMART CHART DATA
// ======================================================
app.get("/chart-data", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q)
      return res.status(400).json({ error: "Parameter 'q' wajib diisi" });

    const expansions = [
      q,
      q.replace(/\s+/g, ""),
      q.replace(" ", "-"),
      q.replace("-", " "),
      q.split(" ").reverse().join(" "),
      q + " vinyl",
      q + " lp",
      q + " record",
      q + " cassette",
    ];

    const uniq = [...new Set(expansions)];

    async function fetchSold(keyword) {
      const url =
        "https://svcs.ebay.com/services/search/FindingService/v1?" +
        "OPERATION-NAME=findCompletedItems" +
        "&SERVICE-VERSION=1.13.0" +
        "&RESPONSE-DATA-FORMAT=JSON" +
        `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}` +
        `&keywords=${encodeURIComponent(keyword)}` +
        "&sortOrder=EndTimeSoonest" +
        "&paginationInput.entriesPerPage=120";

      const resp = await fetch(url);
      const json = await resp.json();

      const items =
        json?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];

      const sold = items
        .filter(
          it => it.sellingStatus?.[0]?.sellingState?.[0] === "EndedWithSales"
        )
        .map(it => ({
          price: Number(
            it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || 0
          ),
          date: new Date(it.listingInfo?.[0]?.endTime?.[0]),
        }));

      return sold;
    }

    let combined = [];
    for (const kw of uniq) {
      const sold = await fetchSold(kw);
      combined.push(...sold);
    }

    const map = new Map();
    combined.forEach(item => {
      const key = item.date.toISOString() + "-" + item.price;
      if (!map.has(key)) map.set(key, item);
    });
    combined = [...map.values()];

    combined.sort((a, b) => b.date - a.date);

    if (combined.length === 0) {
      return res.json({
        query: q,
        expanded_queries: uniq,
        chart: { "30d": null, "60d": null, "90d": null },
      });
    }

    const now = new Date();
    const daysAgo = d => new Date(now.getTime() - d * 86400000);

    const rangeData = days =>
      combined.filter(i => i.date >= daysAgo(days)).map(i => i.price);

    const makeSummary = prices => {
      if (!prices.length) return null;
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      return {
        count: prices.length,
        average: Number(avg.toFixed(2)),
        lowest: Math.min(...prices),
        highest: Math.max(...prices),
      };
    };

    const chart = {
      "30d": makeSummary(rangeData(30)),
      "60d": makeSummary(rangeData(60)),
      "90d": makeSummary(rangeData(90)),
    };

    res.json({
      query: q,
      expanded_queries: uniq,
      total_sold_combined: combined.length,
      chart,
    });
  } catch (err) {
    console.error("❌ Chart Data Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// ROOT
// ======================================================
app.get("/", (req, res) => {
  res.send("🎵 Vinyl Backend is running (Search + Trending + Lookup + Chart)");
});

// ======================================================
// START SERVER
// ======================================================
app.listen(PORT, () => {
  console.log(`🚀 Vinyl Backend v1 running on port ${PORT}`);
});
