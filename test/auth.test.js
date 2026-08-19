import assert from 'node:assert/strict';
import test from 'node:test';
import { digestToken, hashPassword, verifyPassword } from '../db.js';

test('password hashes verify without storing plaintext', () => {
  const password = 'correct horse battery staple';
  const stored = hashPassword(password);
  assert.equal(stored.includes(password), false);
  assert.equal(verifyPassword(password, stored), true);
  assert.equal(verifyPassword('wrong password', stored), false);
});

test('session tokens are stored as deterministic digests', () => {
  assert.equal(digestToken('session-token'), digestToken('session-token'));
  assert.notEqual(digestToken('session-token'), digestToken('other-token'));
});
