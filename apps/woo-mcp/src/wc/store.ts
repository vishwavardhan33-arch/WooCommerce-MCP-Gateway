import { timezoneFromIndex, type StoreTimezone } from "../time.js";
import type { WcClient } from "./client.js";
import type { WpIndex } from "./types.js";

export interface StoreInfo {
  name: string | null;
  url: string | null;
  timezone: StoreTimezone;
}

// WooCommerce's own settings endpoints do not expose the site time zone. The public WordPress REST
// index (GET /wp-json/) does, as timezone_string and gmt_offset, and needs no extra permission.
// Read on every call instead of cached: it is one tiny in-cluster request, and a changed
// time zone setting then takes effect immediately.
export async function loadStoreInfo(wc: WcClient): Promise<StoreInfo> {
  const index = await wc.get<WpIndex>("/");
  return {
    name: index.name ?? null,
    url: index.home ?? index.url ?? null,
    timezone: timezoneFromIndex(index),
  };
}
