import assert from "node:assert/strict";
import { isPrivateOrLoopbackHost, recordSeenHost, getRecordedHost } from "../dist/domain.js";
import { lookupMimeType, MIME_MAP } from "../dist/server.js";
import { resolveGatewayBindHost, resolveGatewayPort, getDefaultConfig, loadConfig } from "../dist/config.js";

console.log("=== 1. Testing isPrivateOrLoopbackHost ===");

// Loopback
assert.equal(isPrivateOrLoopbackHost("127.0.0.1"), true);
assert.equal(isPrivateOrLoopbackHost("127.0.0.2:8080"), true);
assert.equal(isPrivateOrLoopbackHost("localhost"), true);
assert.equal(isPrivateOrLoopbackHost("localhost:18789"), true);
assert.equal(isPrivateOrLoopbackHost("[::1]:18789"), true);
assert.equal(isPrivateOrLoopbackHost("::1"), true);

// Unspecified / Broadcast
assert.equal(isPrivateOrLoopbackHost("0.0.0.0"), true);
assert.equal(isPrivateOrLoopbackHost("0.0.0.0:18789"), true);

// Private IPv4 (RFC 1918)
assert.equal(isPrivateOrLoopbackHost("10.0.0.1"), true);
assert.equal(isPrivateOrLoopbackHost("10.254.0.1:3000"), true);
assert.equal(isPrivateOrLoopbackHost("192.168.1.1"), true);
assert.equal(isPrivateOrLoopbackHost("192.168.0.100:80"), true);
assert.equal(isPrivateOrLoopbackHost("172.16.0.1"), true);
assert.equal(isPrivateOrLoopbackHost("172.24.5.6:443"), true);
assert.equal(isPrivateOrLoopbackHost("172.31.255.255"), true);
assert.equal(isPrivateOrLoopbackHost("172.32.0.1"), false, "172.32.0.1 is public IP");
assert.equal(isPrivateOrLoopbackHost("172.15.255.255"), false, "172.15.255.255 is public IP");

// CGNAT / Tailscale (100.64.0.0/10)
assert.equal(isPrivateOrLoopbackHost("100.64.0.1"), true);
assert.equal(isPrivateOrLoopbackHost("100.100.50.25:80"), true);
assert.equal(isPrivateOrLoopbackHost("100.127.255.255"), true);
assert.equal(isPrivateOrLoopbackHost("100.128.0.1"), false, "100.128.0.1 is public IP");

// Link-local
assert.equal(isPrivateOrLoopbackHost("169.254.1.1"), true);
assert.equal(isPrivateOrLoopbackHost("fe80::1"), true);

// Local domain names
assert.equal(isPrivateOrLoopbackHost("myserver.local"), true);
assert.equal(isPrivateOrLoopbackHost("gateway.lan"), true);
assert.equal(isPrivateOrLoopbackHost("node.internal"), true);
assert.equal(isPrivateOrLoopbackHost("test.localhost"), true);

// Public domains and IPs
assert.equal(isPrivateOrLoopbackHost("example.com"), false);
assert.equal(isPrivateOrLoopbackHost("example.com:443"), false);
assert.equal(isPrivateOrLoopbackHost("files.luiscmerrick.dev"), false);
assert.equal(isPrivateOrLoopbackHost("8.8.8.8"), false);
assert.equal(isPrivateOrLoopbackHost("1.1.1.1:80"), false);
assert.equal(isPrivateOrLoopbackHost("203.0.113.1"), false);

console.log("✓ isPrivateOrLoopbackHost tests passed");

console.log("=== 2. Testing MIME fallback ===");
assert.equal(lookupMimeType("document.pdf"), "application/pdf");
assert.equal(lookupMimeType("image.png"), "image/png");
assert.equal(lookupMimeType("archive.zip"), "application/zip");
assert.equal(lookupMimeType("script.py"), "text/plain; charset=utf-8");
assert.equal(lookupMimeType("data.json"), "application/json; charset=utf-8");

// Fallback for unknown extension
assert.equal(lookupMimeType("file.unknownext"), "application/octet-stream");
assert.equal(lookupMimeType("file_without_ext"), "application/octet-stream");
assert.equal(lookupMimeType(".unknown"), "application/octet-stream");
assert.equal(lookupMimeType("blob.xyz123"), "application/octet-stream");

console.log("✓ MIME fallback tests passed");

console.log("=== 3. Testing Gateway Bind & Port resolution ===");
// Gateway bind host
assert.equal(resolveGatewayBindHost({ bind: "lan" }), "0.0.0.0");
assert.equal(resolveGatewayBindHost({ bind: "loopback" }), "127.0.0.1");
assert.equal(resolveGatewayBindHost({ bind: "custom", customBindHost: "192.168.1.50" }), "192.168.1.50");
assert.equal(resolveGatewayBindHost({ bind: "tailnet" }), "127.0.0.1");

// Gateway port
assert.equal(resolveGatewayPort({ port: 19999 }), 19999);

// Default config inherits gateway bind
const cfg = getDefaultConfig({ bind: "lan", port: 18789 });
assert.equal(cfg.gateway.bind, "lan");
assert.equal(resolveGatewayBindHost(cfg.gateway), "0.0.0.0");

const cfgLoopback = getDefaultConfig({ bind: "loopback" });
assert.equal(resolveGatewayBindHost(cfgLoopback.gateway), "127.0.0.1");

console.log("✓ Gateway Bind & Port resolution tests passed");

console.log("All unit tests passed successfully!");
