# Campaign Admin Runbook

## Daily work

1. Open `/admin` and sign in with an individual staff account.
2. Start in **CRM Inbox**. Filter new requests by type and ZIP code.
3. Open a supporter, review the complete engagement history, add an internal note, assign a follow-up task, and move each request to its current status.
4. Use **Events** to create drafts. Confirm the venue, time zone, accessibility notes, capacity, and campaign contact before changing an event to `published`.
5. Export CSV only when operationally necessary. Store exports in an approved campaign location and delete working copies when finished.

## Campaign email and Resend

The **Email** admin section is installed but remains safely disabled until all required Resend settings exist. The dashboard shows unread, unassigned, and follow-up email counts. Staff can read threads, assign ownership, link or create CRM contacts, add private notes, mark follow-up state, archive, report spam, and reply with up to five attachments totaling 8 MB.

Before activation:

1. Create the campaign Resend account and verify a dedicated sending domain.
2. Configure a Resend receiving domain. Prefer an email subdomain so enabling inbound MX records does not unexpectedly replace an existing mailbox provider.
3. Add a Resend webhook pointing to `https://CAMPAIGN-DOMAIN/api/webhooks/resend` for `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, and `email.failed`.
4. Add these protected GitHub production secrets: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_REPLY_TO`, and `RESEND_WEBHOOK_SECRET`.
5. Redeploy, then confirm `/api/admin/email/status` reports `enabled: true` while authenticated.
6. Send a real inbound test email, confirm it appears once in the inbox, reply from admin, and confirm threading and delivery status.

Resend webhook signatures are checked against the raw request body. Duplicate webhook IDs are ignored. Failed inbound processing is left retryable. Never paste API keys or webhook signing secrets into issues, chat, logs, or source control.

Inbound HTML is stored for future safe rendering, but the admin deliberately displays the plain-text body so untrusted email markup cannot execute. Attachment metadata is shown without rendering executable content inline. Executable outbound attachments are blocked.

To disable email immediately, clear any one of `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, or `RESEND_WEBHOOK_SECRET` and redeploy. Existing email records remain available for campaign retention and incident review.

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
