import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { RestPayPal } from '../src/paypal/rest.js';
import { PayPalError } from '../src/paypal/types.js';

test('REST client: OAuth, payout request shape, idempotency header, error parsing', async () => {
  const seen: { path: string; headers: Record<string, unknown>; body: any }[] = [];
  const app = express();
  app.use(express.json(), express.urlencoded({ extended: false }));
  app.post('/v1/oauth2/token', (req, res) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
    assert.equal(req.body.grant_type, 'client_credentials');
    res.json({ access_token: 'tok', expires_in: 32400 });
  });
  app.post('/v1/payments/payouts', (req, res) => {
    seen.push({ path: req.path, headers: req.headers, body: req.body });
    if (req.body.sender_batch_header.sender_batch_id === 'BAD') {
      res.status(422).json({ name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.', debug_id: 'dbg123' });
      return;
    }
    res.status(201).json({ batch_header: { payout_batch_id: 'PB123', batch_status: 'PENDING' } });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const pp = new RestPayPal({ mode: 'sandbox', paypalClientId: 'id', paypalClientSecret: 'secret' }, base);
    const r = await pp.createPayout({
      senderBatchId: 'CS-1', emailSubject: 's', emailMessage: 'm',
      items: [{ senderItemId: 'CS-1-01', receiver: 'a@b.com', amountCents: 323000, currency: 'USD', note: 'n' }],
    });
    assert.deepEqual(r, { payout_batch_id: 'PB123', batch_status: 'PENDING' });
    const sent = seen[0];
    assert.equal(sent.headers.authorization, 'Bearer tok');
    assert.equal(sent.headers['paypal-request-id'], 'CS-1');
    assert.equal(sent.body.sender_batch_header.sender_batch_id, 'CS-1');
    assert.deepEqual(sent.body.items[0], { recipient_type: 'EMAIL', amount: { value: '3230.00', currency: 'USD' }, note: 'n', sender_item_id: 'CS-1-01', receiver: 'a@b.com' });

    await assert.rejects(
      pp.createPayout({ senderBatchId: 'BAD', emailSubject: 's', emailMessage: 'm', items: [{ senderItemId: 'x', receiver: 'a@b.com', amountCents: 1, currency: 'USD', note: '' }] }),
      (err: PayPalError) => err.status === 422 && err.code === 'INSUFFICIENT_FUNDS' && err.debugId === 'dbg123',
    );
  } finally {
    server.close();
  }
});
