<?php
// NAV.FUN — same-origin JSON-RPC relay (read fallback for the Floor terminal).
//
// WHY THIS EXISTS: the official Robinhood Chain RPC intermittently emits a
// duplicated `Access-Control-Allow-Origin: *,*` header. When a browser's HTTP/2
// connection lands on an affected upstream, EVERY request on that connection is
// blocked by CORS and the app cannot read the chain. This relay forwards the
// exact same JSON-RPC request server-to-server (no CORS applies), to the SAME
// official endpoint. No state, no logging, no third parties, no keys.
//
// The app uses the official RPC directly first and only falls back here.

declare(strict_types=1);

const UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com/';
const MAX_BODY = 262144; // 256 KB — far above any batched read the app makes

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    exit;
}

$body = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
if ($body === false || $body === '' || strlen($body) > MAX_BODY) {
    http_response_code(413);
    exit;
}

$req = json_decode($body, true);
if ($req === null) {
    http_response_code(400);
    exit;
}

if (!function_exists('array_is_list')) {
    function array_is_list(array $a): bool
    {
        return $a === [] || array_keys($a) === range(0, count($a) - 1);
    }
}

// Standard namespaces only (eth_/net_/web3_) — single request or batch of <=100.
$check = static function ($r): bool {
    return is_array($r)
        && isset($r['method']) && is_string($r['method'])
        && preg_match('/^(eth|net|web3)_[A-Za-z0-9]+$/', $r['method']) === 1;
};
$valid = array_is_list($req)
    ? ($req !== [] && count($req) <= 100 && !in_array(false, array_map($check, $req), true))
    : $check($req);
if (!$valid) {
    http_response_code(400);
    exit;
}

$ch = curl_init(UPSTREAM);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $body,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 25,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
]);
$resp = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($resp === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"relay: upstream unreachable"}}';
    exit;
}

http_response_code($code > 0 ? $code : 502);
header('Content-Type: application/json');
echo $resp;
