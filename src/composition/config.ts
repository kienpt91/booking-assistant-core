/** Configuration of `serve`, read from the environment. */
export interface ServeConfig {
  readonly databaseUrl: string;
  /** key ring for phone numbers and names: `id=key,id2=key2` (the first is active) or one bare key */
  readonly piiKeys: string;
  /** key ring for reply and conversation text */
  readonly messageKeys: string;
  readonly phoneHashKey: string;
  readonly webhookSecrets: readonly string[];
  readonly channel: string;
  readonly host: string;
  readonly port: number;
  readonly modelBaseUrl: string;
  readonly modelApiKey: string;
  readonly modelName: string;
  readonly relayUrl: string;
  readonly relayToken: string;
  readonly defaultCountryCode: string | undefined;
  /** authenticated webhook requests per sender address per minute */
  readonly requestsPerMinute: number;
  readonly maxBodyBytes: number;
  readonly toleranceMs: number;
  /** reverse proxies in front of the server that append to X-Forwarded-For; 0 ignores the header */
  readonly trustedProxyHops: number;
}

const REQUIRED = ["DATABASE_URL", "PII_KEYS", "MESSAGE_KEYS", "PHONE_HASH_KEY", "WEBHOOK_SECRETS", "MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME", "RELAY_URL", "RELAY_TOKEN"] as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https, or http on this machine only: the bearer tokens, the numbers and the conversation travel over these URLs. */
function httpsUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an https URL`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return value;
  throw new Error(`${name} must be an https URL (plain http is accepted for localhost only)`);
}

function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

/** Reads the configuration of `serve` from the environment. A missing variable is named; no value is ever printed. */
export function readServeConfig(env: Readonly<Record<string, string | undefined>>): ServeConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const get = (name: (typeof REQUIRED)[number]): string => env[name] as string;
  const secrets = get("WEBHOOK_SECRETS").split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.some((s) => s.length < 32)) throw new Error("every webhook secret must be at least 32 characters");
  const port = Number(env["PORT"] ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a port number");
  return {
    databaseUrl: get("DATABASE_URL"),
    piiKeys: get("PII_KEYS"),
    messageKeys: get("MESSAGE_KEYS"),
    phoneHashKey: get("PHONE_HASH_KEY"),
    webhookSecrets: secrets,
    channel: env["CHANNEL"] ?? "whatsapp",
    host: env["HOST"] ?? "127.0.0.1",
    port,
    modelBaseUrl: httpsUrl("MODEL_BASE_URL", get("MODEL_BASE_URL")),
    modelApiKey: get("MODEL_API_KEY"),
    modelName: get("MODEL_NAME"),
    relayUrl: httpsUrl("RELAY_URL", get("RELAY_URL")),
    relayToken: get("RELAY_TOKEN"),
    defaultCountryCode: env["DEFAULT_COUNTRY_CODE"],
    requestsPerMinute: integer(env, "WEBHOOK_REQUESTS_PER_MINUTE", 600, 1, 100_000),
    maxBodyBytes: integer(env, "WEBHOOK_MAX_BODY_BYTES", 65_536, 1_024, 1_048_576),
    toleranceMs: integer(env, "WEBHOOK_TOLERANCE_SECONDS", 300, 5, 3_600) * 1000,
    trustedProxyHops: integer(env, "TRUSTED_PROXY_HOPS", 0, 0, 3),
  };
}
