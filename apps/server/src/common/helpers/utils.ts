import * as path from 'path';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { sanitize } from 'sanitize-filename-ts';
import { FastifyRequest } from 'fastify';
import * as slugify from "@sindresorhus/slugify";

export const envPath = path.resolve(process.cwd(), '..', '..', '.env');

export async function hashPassword(password: string) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

export async function comparePasswordHash(
  plainPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(plainPassword, passwordHash);
}

export function generateRandomSuffixNumbers(length: number) {
  return Math.random()
    .toFixed(length)
    .substring(2, 2 + length);
}

export type RedisConfig = {
  host: string;
  port: number;
  db: number;
  password?: string;
  family?: number;
};

export function parseRedisUrl(redisUrl: string): RedisConfig {
  // format - redis[s]://[[username][:password]@][host][:port][/db-number][?family=4|6]
  const url = new URL(redisUrl);
  const { hostname, port, password, pathname, searchParams } = url;
  const portInt = parseInt(port, 10);

  let db: number = 0;
  // extract db value if present
  if (pathname.length > 1) {
    const value = pathname.slice(1);
    if (!isNaN(parseInt(value))) {
      db = parseInt(value, 10);
    }
  }

  // extract family from query parameters
  let family: number | undefined;
  const familyParam = searchParams.get('family');
  if (familyParam && !isNaN(parseInt(familyParam))) {
    family = parseInt(familyParam, 10);
  }

  return { host: hostname, port: portInt, password, db, family };
}

export function createRetryStrategy() {
  return function (times: number): number {
    return Math.max(Math.min(Math.exp(times), 20000), 3000);
  };
}

export function extractDateFromUuid7(uuid7: string) {
  //https://park.is/blog_posts/20240803_extracting_timestamp_from_uuid_v7/
  const parts = uuid7.split('-');
  const highBitsHex = parts[0] + parts[1].slice(0, 4);
  const timestamp = parseInt(highBitsHex, 16);

  return new Date(timestamp);
}

export function sanitizeFileName(fileName: string): string {
  const sanitizedFilename = sanitize(fileName)
    .replace(/ /g, '_')
    .replace(/#/g, '_');
  return sanitizedFilename.slice(0, 255);
}

export function removeAccent(str: string): string {
  if (!str) return str;
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function extractBearerTokenFromHeader(
  request: FastifyRequest,
): string | undefined {
  const authorizationHeader =
    request.headers.authorization || request.headers['Authorization'] as string;

  const isString = typeof authorizationHeader === 'string';
  if (!authorizationHeader || !isString) {
    return undefined;
  }

  const [type, token] = authorizationHeader.split(' ') ?? [];
  return type === 'Bearer' ? token : undefined;
}

export function hasLicenseOrEE(opts: {
  licenseKey: string;
  plan: string;
  isCloud: boolean;
}): boolean {
  const { licenseKey, plan, isCloud } = opts;
  return Boolean(licenseKey) || (isCloud && plan === 'business');
}

export function extractUsernameAndSpaceName(userName: string): {
  username: string;
  namespace: string;
} {
  const atSign = '@';
  
  let username = userName;
  let namespace = 'Личное пространство';

  const isEmail = username.includes(atSign);

  if (isEmail) {
    [username] = username.split(atSign);
    namespace = `Пространство для ${username}`;
  }

  return { username, namespace };
}


export function buildPageSlug (pageSlugId: string, pageTitle?: string): string {
  const titleSlug = slugify(pageTitle?.substring(0, 70) || "untitled", {
    customReplacements: [
      ["♥", ""],
      ["🦄", ""],
    ],
  });

  return `${titleSlug}-${pageSlugId}`;
}

export function generateDeviceFingerprint(req: FastifyRequest): string {

  // Extract request properties
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const acceptLanguage = req.headers['accept-language'] || '';
  const acceptEncoding = req.headers['accept-encoding'] || '';

  // Create fingerprint string
  const fingerprintString = `${ip}|${userAgent}|${acceptLanguage}|${acceptEncoding}`;

  // Hash it
  const hash = crypto.createHash('sha256');
  hash.update(fingerprintString);

  return hash.digest('hex');
}

/**
 * Slugify a string to create URL-friendly slugs.
 * Supports Cyrillic (а-я, а-я), English letters (a-z), and numbers (0-9).
 * Converts to lowercase and replaces spaces and special characters with hyphens.
 *
 * @param input - The string to slugify
 * @returns The slugified string, or empty string if input is empty or contains only special characters
 */
export function slugifySpace(input: string): string {
  if (!input) {
    return '';
  }

  let result = input.toLowerCase();

  // Cyrillic Unicode ranges: а-я (U+0430-U+044F), а-я (U+0451)
  result = result.replace(/[^a-z0-9\u0430-\u044f\u0451]+/g, '-');

  // Remove consecutive hyphens
  result = result.replace(/-+/g, '-');

  // Remove leading and trailing hyphens
  result = result.replace(/^-+|-+$/g, '');

  return result;
}

/**
 * Convert a string to capital case.
 * First slugifies the input using slugifySpace, then capitalizes the first letter,
 * and finally replaces hyphens with spaces.
 *
 * @param input - The string to convert to capital case
 * @returns The string in capital case, or empty string if input is empty or contains only special characters
 *
 * @example
 * toCapitalCase("Hello World") // Returns "Hello world"
 * toCapitalCase("Привет мир") // Returns "Привет мир"
 * toCapitalCase("TEST SPACE") // Returns "Test space"
 * toCapitalCase("Test@#$%^&*()World") // Returns "Test world"
 */
export function toCapitalCase(input: string): string {
  if (!input) {
    return '';
  }

  // First, slugify the input using slugifySpace
  const slugified = slugifySpace(input);

  // Handle edge case: if slugification resulted in empty string (e.g., only special characters)
  if (!slugified) {
    return '';
  }

  // Capitalize only the first letter of the slugified string
  const capitalized = slugified.charAt(0).toUpperCase() + slugified.slice(1);

  // Replace all hyphens with spaces
  const result = capitalized.replace(/-/g, ' ');

  return result;
}
