/** Add persisted expiry deadlines and retain existing duties for 30 days from migration. */
import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE validator_duties ADD COLUMN expires_at TIMESTAMP
      DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days';
    CREATE INDEX idx_validator_duties_expiry ON validator_duties(expires_at) WHERE expires_at IS NOT NULL;
    UPDATE schema_version SET version = 3 WHERE version = 2;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE validator_duties DROP COLUMN expires_at;
    UPDATE schema_version SET version = 2 WHERE version = 3;
  `);
}
