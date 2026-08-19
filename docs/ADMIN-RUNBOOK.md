# Campaign Admin Runbook

## Daily work

1. Open `/admin` and sign in with an individual staff account.
2. Start in **CRM Inbox**. Filter new requests by type and ZIP code.
3. Open a supporter, review the complete engagement history, add an internal note, assign a follow-up task, and move each request to its current status.
4. Use **Events** to create drafts. Confirm the venue, time zone, accessibility notes, capacity, and campaign contact before changing an event to `published`.
5. Export CSV only when operationally necessary. Store exports in an approved campaign location and delete working copies when finished.

## Event states

- `draft`: staff only.
- `published`: visible on the public involvement page and accepting RSVPs.
- `canceled`: hidden from new public RSVPs. Staff must contact existing attendees.
- `completed`: retained for reporting.
- `archived`: retained but removed from active workflows.

## Backups

Run `scripts/backup-postgres.sh` from `/opt/apps/lb26`. It creates a compressed PostgreSQL dump and verifies the gzip archive. The default retention is 14 days.

Restore into a clean database before relying on a backup:

```sh
gunzip -c backups/lb26-YYYYMMDDTHHMMSSZ.sql.gz | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

Never restore over production without taking a fresh backup and stopping campaign intake.

## Credential rotation

Admin passwords are stored only as scrypt hashes. Do not place passwords in GitHub issues, chat, logs, or commits. Database and bootstrap credentials belong in the deployment host's protected `.env` file.

## Privacy requests

Contact anonymization is a deliberate admin-only operation that requires the literal confirmation `ANONYMIZE`. It clears direct identifiers, addresses, private notes, request payloads, assignments, and follow-up dates while retaining non-identifying request/event counts for campaign reporting. Confirm the requester's identity and campaign retention obligations before using it.

## Incident response

If supporter data may be exposed, stop admin access, preserve audit logs, rotate affected credentials, document the time window and affected records, and notify campaign leadership. Do not delete audit records during investigation.
