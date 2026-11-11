import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getActiveMandate, verifyMandate } from '../src/core/mandate.js';
import { testContext } from './helpers.js';

test('audit chain verifies, and detects edits and deletions', () => {
  const ctx = testContext();
  ctx.audit.append('tester', 'test.event', { n: 1 });
  const ok = ctx.audit.verify();
  assert.ok(ok.ok);
  assert.ok(ok.entries > 5);

  ctx.db.prepare("UPDATE audit SET data = '{\"n\":2}' WHERE action = 'test.event'").run();
  const edited = ctx.audit.verify();
  assert.equal(edited.ok, false);
  assert.match(edited.reason!, /modified/);

  const ctx2 = testContext();
  ctx2.db.prepare('DELETE FROM audit WHERE seq = 3').run();
  assert.equal(ctx2.audit.verify().ok, false);
});

test('mandate signature fails if terms are edited in the database', () => {
  const ctx = testContext();
  const m = getActiveMandate(ctx.db)!;
  assert.ok(verifyMandate(m, ctx.mandateKey));
  const tampered = { ...m, terms: { ...m.terms, max_per_payment_cents: 99_999_999 } };
  assert.equal(verifyMandate(tampered, ctx.mandateKey), false);
  assert.equal(verifyMandate(m, 'some-other-key'), false);
});
