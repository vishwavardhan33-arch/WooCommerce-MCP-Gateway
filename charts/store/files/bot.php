<?php
// Run inside WordPress by `wp eval-file`.
// Keeps the bot's Application Password if the one stored in the Kubernetes Secret still verifies
// against WordPress; otherwise replaces it and writes the NEW plain password to $APP_PASSWORD_OUT
// (the shell then stores it in the Secret). WordPress keeps only a hash, so a lost password cannot
// be recovered, only replaced.
$login   = getenv('BOT_USER');
$appName = getenv('BOT_APP_NAME');
$current = (string) getenv('EXISTING_APP_PASSWORD');   // empty when the Secret does not exist yet
$out     = getenv('APP_PASSWORD_OUT');

$user = get_user_by('login', $login);
if (!$user) {
    WP_CLI::error("user $login does not exist");
}

foreach (WP_Application_Passwords::get_user_application_passwords($user->ID) as $item) {
    if ($item['name'] !== $appName) {
        continue;
    }
    if ($current !== '' && wp_check_password($current, $item['password'])) {
        WP_CLI::log('application password in the Secret is still valid');
        return;
    }
    WP_CLI::log('application password is stale, replacing it');
    WP_Application_Passwords::delete_application_password($user->ID, $item['uuid']);
}

$created = WP_Application_Passwords::create_new_application_password($user->ID, ['name' => $appName]);
if (is_wp_error($created)) {
    WP_CLI::error($created->get_error_message());
}
file_put_contents($out, $created[0]);   // $created[0] = plain password; never printed to the log
WP_CLI::log('issued a new application password');
