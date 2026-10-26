<?php
// Run inside WordPress by `wp eval-file`. Idempotent: reads state, changes only differences.

// Cash on delivery: the "test-friendly" payment method.
$cod = get_option('woocommerce_cod_settings');
$cod = is_array($cod) ? $cod : [];
if (($cod['enabled'] ?? '') !== 'yes') {
    update_option('woocommerce_cod_settings', array_merge([
        'title'              => 'Cash on delivery',
        'description'        => 'Pay with cash upon delivery.',
        'instructions'       => 'Pay with cash upon delivery.',
        'enable_for_methods' => [],
        'enable_for_virtual' => 'yes',
    ], $cod, ['enabled' => 'yes']));
    WP_CLI::log('COD enabled');
}

// Demo simplification: no shipping. Otherwise checkout of physical products needs a shipping
// zone and method before an order can be placed.
if (get_option('woocommerce_ship_to_countries') !== 'disabled') {
    update_option('woocommerce_ship_to_countries', 'disabled');
    WP_CLI::log('shipping disabled');
}

// New WooCommerce stores can start in "coming soon" mode, which hides the storefront from visitors.
if (get_option('woocommerce_coming_soon') !== 'no') {
    update_option('woocommerce_coming_soon', 'no');
    WP_CLI::log('coming-soon mode off');
}

// Seed products once. The flag stops deleted demo products from coming back on every upgrade.
if (!get_option('store_seed_done')) {
    $products = json_decode((string) file_get_contents('/scripts/products.json'), true);
    foreach ((array) $products as $p) {
        if (wc_get_product_id_by_sku($p['sku'])) {
            continue;   // partially seeded earlier: skip what exists
        }
        $product = new WC_Product_Simple();
        $product->set_name($p['name']);
        $product->set_sku($p['sku']);
        $product->set_regular_price($p['price']);
        $product->set_description($p['description'] ?? '');
        $product->set_status('publish');
        $product->save();
        WP_CLI::log('seeded ' . $p['sku']);
    }
    update_option('store_seed_done', '1');
}
