'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkOwnerMatch } = require('../scripts/setup-github');

test('checkOwnerMatch accepts a token owned by the repo owner (case-insensitive)', () => {
  checkOwnerMatch('Nikhil1231', 'nikhil1231', false);
});

test('checkOwnerMatch rejects a cross-owner token', () => {
  assert.throws(
    () => checkOwnerMatch('ticket-runner-bot', 'nikhil1231', false),
    /belongs to ticket-runner-bot but the repo owner is nikhil1231/
  );
});

test('checkOwnerMatch allows a cross-owner token with --allow-cross-owner', () => {
  checkOwnerMatch('ticket-runner-bot', 'nikhil1231', true);
});
