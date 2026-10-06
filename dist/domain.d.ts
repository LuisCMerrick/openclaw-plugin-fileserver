import type { IncomingMessage } from "node:http";
/**
 * Checks if a host/IP is private, loopback, link-local, or local broadcast/unspecified.
 * Uses standard IP structure and CIDR boundaries without hardcoded subnet strings.
 */
export declare function isPrivateOrLoopbackHost(rawHost?: string): boolean;
export declare function recordSeenHost(hostHeader?: string): void;
export declare function getRecordedHost(): string | null;
export declare function detectActiveDomain(gatewayConfig?: any): string;
export declare function requestOrigin(req: IncomingMessage, gatewayConfig?: any): string;
