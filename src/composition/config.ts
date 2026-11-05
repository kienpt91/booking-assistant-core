export interface ServeConfig {
  readonly databaseUrl: string;
  readonly piiKey: string;
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
}

const REQUIRED = ["DATABASE_URL", "PII_KEY", "PHONE_HASH_KEY", "WEBHOOK_SECRETS", "MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME", "RELAY_URL", "RELAY_TOKEN"] as const;

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
    piiKey: get("PII_KEY"),
    phoneHashKey: get("PHONE_HASH_KEY"),
    webhookSecrets: secrets,
    channel: env["CHANNEL"] ?? "whatsapp",
    host: env["HOST"] ?? "127.0.0.1",
    port,
    modelBaseUrl: get("MODEL_BASE_URL"),
    modelApiKey: get("MODEL_API_KEY"),
    modelName: get("MODEL_NAME"),
    relayUrl: get("RELAY_URL"),
    relayToken: get("RELAY_TOKEN"),
    defaultCountryCode: env["DEFAULT_COUNTRY_CODE"],
  };
}

