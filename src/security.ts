import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ShortCodeCharset = "23456789abcdefghjkmnpqrstuvwxyz";
export const ShortCodeLength = 8;

export function generateShortCode(): string {
  let result = "";
  const len = ShortCodeCharset.length;
  for (let i = 0; i < ShortCodeLength; i++) {
    const idx = crypto.randomInt(0, len);
    result += ShortCodeCharset[idx];
  }
  return result;
}

export function safeResolve(allowedRoot: string, userPath: string): { absPath: string; relPath: string } {
  if (!allowedRoot) {
    throw new Error("allowedRoot cannot be empty");
  }

  const cleanRoot = path.resolve(path.normalize(allowedRoot));
  let evalRoot = cleanRoot;
  try {
    evalRoot = fs.realpathSync(cleanRoot);
  } catch {
    evalRoot = cleanRoot;
  }

  let candidate: string;
  if (path.isAbsolute(userPath)) {
    candidate = path.resolve(path.normalize(userPath));
  } else {
    candidate = path.resolve(path.join(cleanRoot, userPath));
  }

  // Lexical check
  if (candidate !== cleanRoot && !candidate.startsWith(cleanRoot + path.sep)) {
    throw new Error(`security violation: ${candidate} is outside allowed root ${cleanRoot}`);
  }

  // Realpath check for target or parent
  if (fs.existsSync(candidate)) {
    const evalTarget = fs.realpathSync(candidate);
    if (evalTarget !== evalRoot && !evalTarget.startsWith(evalRoot + path.sep)) {
      throw new Error(`security violation: symlink targets outside allowed root (${evalTarget})`);
    }
    candidate = evalTarget;
  } else {
    // Check closest existing parent
    let parent = path.dirname(candidate);
    while (true) {
      if (fs.existsSync(parent)) {
        const evalParent = fs.realpathSync(parent);
        if (evalParent !== evalRoot && !evalParent.startsWith(evalRoot + path.sep)) {
          throw new Error(`security violation: parent directory resolves outside allowed root (${evalParent})`);
        }
        break;
      }
      const newParent = path.dirname(parent);
      if (newParent === parent) break;
      parent = newParent;
    }
  }

  const rel = path.relative(evalRoot, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("security violation: path escapes allowed root");
  }

  // Normalize slashes for posix consistency
  const relPathPosix = rel.split(path.sep).join("/");
  return { absPath: candidate, relPath: relPathPosix };
}

export function sanitizeFilename(raw: string): string {
  let base = path.basename(raw);
  base = base.replace(/[\\/]/g, "_");
  base = base.replace(/[\x00-\x1F\x7F]/g, "").trim();
  while (base.startsWith(".")) {
    base = base.slice(1);
  }
  if (!base || base === "." || base === "..") {
    base = `upload_${Math.floor(Date.now() / 1000)}.bin`;
  }
  return base;
}

export function generateHmacSignature(secretKey: string, relPath: string, expires: number): string {
  const hmac = crypto.createHmac("sha256", secretKey);
  hmac.update(`${relPath}:${expires}`);
  return hmac.digest("hex");
}

export function validateHmacSignature(
  secretKey: string,
  relPath: string,
  expires: number,
  expectedSig: string
): boolean {
  if (Math.floor(Date.now() / 1000) > expires) {
    return false;
  }
  const actualSig = generateHmacSignature(secretKey, relPath, expires);
  try {
    return crypto.timingSafeEqual(Buffer.from(actualSig, "utf-8"), Buffer.from(expectedSig, "utf-8"));
  } catch {
    return false;
  }
}

export function formatRFC5987ContentDisposition(inline: boolean, filename: string): string {
  const disposition = inline ? "inline" : "attachment";
  // ASCII fallback: replace non-ascii or unsafe chars
  let asciiFallback = filename.replace(/[^\x20-\x7E]|["\\;]/g, "_");
  if (!asciiFallback) asciiFallback = "file";

  const utf8Encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}
