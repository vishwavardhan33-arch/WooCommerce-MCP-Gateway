// Only the fields this server reads. WooCommerce returns far more (links, meta_data, addresses...);
// everything not listed here is dropped before it reaches the model.

export interface WcProduct {
  id: number;
  name: string;
  permalink: string;
  sku: string;
  price: string;
  status: string;
  stock_status: string;
}

export interface WcLineItem {
  name: string;
  sku?: string;
  quantity: number;
  total: string;
}

export interface WcOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  date_created_gmt: string;
  payment_method_title?: string;
  customer_note?: string;
  billing?: { first_name?: string; last_name?: string };
  line_items: WcLineItem[];
}

/** The public WordPress REST index: GET /wp-json/ */
export interface WpIndex {
  name?: string;
  url?: string;
  home?: string;
  gmt_offset?: string | number;
  timezone_string?: string;
}
