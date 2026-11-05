// The use case scenarios of test/contract, run on PostgreSQL through the real adapter and the real roles. They are the same
// scenarios the in-memory double passes in test/application/booking.test.ts.
import { usePostgresBackend } from "../support/pg-backend.js";
import "../contract/booking.scenarios.js";

usePostgresBackend();
