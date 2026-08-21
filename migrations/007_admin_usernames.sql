ALTER TABLE admin_users ADD COLUMN username text;
UPDATE admin_users SET username=email WHERE username IS NULL;
ALTER TABLE admin_users ALTER COLUMN username SET NOT NULL;
ALTER TABLE admin_users ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX admin_users_username_unique ON admin_users (lower(username));

