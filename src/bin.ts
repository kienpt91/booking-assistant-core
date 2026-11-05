#!/usr/bin/env node
import { migrate, MIGRATIONS_DIR, readServeConfig, startServer } from "./composition/compose.js";
import { runDemo } from "./demo/main.js";

const USAGE = `usage: booking-assistant-core <command>

  migrate   apply the SQL migrations. DATABASE_ADMIN_URL: the schema owner's connection string.
  serve     start the webhook server. See docs/deployment.md for the environment variables.
  demo      run the demonstration against a throwaway server. DEMO_ADMIN_URL: its superuser connection string.
`;

async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const command = argv[0];
  if (command === "migrate") {
    const url = env["DATABASE_ADMIN_URL"];
    if (!url) return fail("DATABASE_ADMIN_URL is not set");
    const report = await migrate(url, MIGRATIONS_DIR);
    console.log(`applied ${report.applied.length} migration(s), ${report.alreadyApplied.length} already applied`);
    return 0;
  }
  if (command === "serve") {
    const config = readServeConfig(env);
    const running = await startServer(config, (line) => console.log(line));
    const stop = (): void => void running.stop().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return -1;
  }
  if (command === "demo") {
    const url = env["DEMO_ADMIN_URL"];
    if (!url) return fail("DEMO_ADMIN_URL is not set (it must be the superuser URL of a throwaway server; see scripts/demo.sh)");
    return runDemo(url, (line) => console.log(line));
  }
  console.error(USAGE);
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  },
);
