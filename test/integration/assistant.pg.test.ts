// The conversation scenarios of test/contract, run on PostgreSQL: the same pipeline, the real roles and policies, the real adapter.
import { usePostgresBackend } from "../support/pg-backend.js";
import "../contract/assistant.scenarios.js";

usePostgresBackend();
