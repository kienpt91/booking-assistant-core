// The use case scenarios of test/contract run here on the in-memory double of the store (the default backend) and
// in test/integration/booking.pg.test.ts on PostgreSQL: the double is only trusted because both agree.
import "../contract/booking.scenarios.js";
