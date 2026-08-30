'use strict';

const axios = require('axios');
const crypto = require('crypto');

function buildSigiloClient() {
  const baseURL = process.env.SIGILO_PAY_BASE_URL;
  const apiKey = process.env.SIGILO_PAY_API_KEY;

  if (!baseURL) {
    throw new Error('SIGILO_PAY_BASE_URL is required');
  }

  if (!apiKey) {
    throw new Error('SIGILO_PAY_API_KEY is required');
  }

  return axios.create({
    baseURL: baseURL.replace(/\/+$/, ''),
    timeout: 30000,
    headers: {
      apikey: apiKey,
      'Content-Type': 'application/json'
    }
  });
}

function createOrderId() {
  return crypto.randomUUID();
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Payment amount must be a positive number');
  }
  return amount;
}

async function createPayment({
  orderId = createOrderId(),
  customerName,
  customerPhone,
  amount,
  description,
  contentUrl,
  metadata = {}
}) {
  const client = buildSigiloClient();
  const createPath = process.env.SIGILO_PAY_CREATE_PAYMENT_PATH || '/payments/create';
  const webhookUrl = process.env.SIGILO_PAY_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error('SIGILO_PAY_WEBHOOK_URL is required');
  }

  const normalizedAmount = normalizeAmount(amount);

  const payload = {
    amount: normalizedAmount,
    description: description || process.env.BOT_PRODUCT_DESCRIPTION || 'Cobrança PIX',
    customer: {
      name: customerName || 'Cliente',
      phone: customerPhone ? String(customerPhone) : undefined
    },
    webhookUrl,
    referenceId: orderId,
    externalReference: orderId,
    metadata: {
      orderId,
      contentUrl: contentUrl || process.env.BOT_CONTENT_URL,
      ...metadata
    }
  };

  const response = await client.post(createPath, payload);

  return {
    orderId,
    amount: normalizedAmount,
    raw: response.data,
    paymentId:
      response.data?.payment?.id ||
      response.data?.data?.payment?.id ||
      response.data?.id ||
      null,
    status:
      response.data?.payment?.status ||
      response.data?.data?.payment?.status ||
      response.data?.status ||
      null,
    pixCopyPaste:
      response.data?.pixCopyPaste ||
      response.data?.payment?.pixCopyPaste ||
      response.data?.data?.payment?.pixCopyPaste ||
      response.data?.data?.pixCopyPaste ||
      response.data?.copyPaste ||
      response.data?.payment?.copiaECola ||
      null,
    qrCode:
      response.data?.qrCode ||
      response.data?.payment?.qrCode ||
      response.data?.data?.payment?.qrCode ||
      response.data?.data?.qrCode ||
      response.data?.qrcode ||
      null,
    checkoutUrl:
      response.data?.checkoutUrl ||
      response.data?.payment?.checkoutUrl ||
      response.data?.data?.payment?.checkoutUrl ||
      response.data?.paymentUrl ||
      null
  };
}

function verifyWebhookSecret(req) {
  const expectedSecret = process.env.SIGILO_PAY_WEBHOOK_SECRET;
  if (!expectedSecret) return true;

  const receivedSecret =
    req.get('x-webhook-secret') ||
    req.get('x-sigilo-secret') ||
    req.get('authorization') ||
    '';

  return receivedSecret === expectedSecret;
}

function normalizePaidWebhook(body) {
  const event = body?.event || body?.type || body?.status || null;
  const payment =
    body?.payment ||
    body?.data?.payment ||
    body?.data ||
    body?.transaction ||
    null;

  const status = String(payment?.status || body?.status || event || '').toLowerCase();
  const isPaid = status === 'paid' || event === 'paid' || event === 'payment.paid';

  return {
    isPaid,
    orderId:
      payment?.referenceId ||
      payment?.externalReference ||
      payment?.metadata?.orderId ||
      payment?.metadata?.referenceId ||
      payment?.orderId ||
      body?.orderId ||
      null,
    customerPhone:
      payment?.customer?.phone ||
      payment?.customerPhone ||
      payment?.metadata?.customerPhone ||
      body?.customerPhone ||
      null,
    customerName:
      payment?.customer?.name ||
      payment?.customerName ||
      payment?.metadata?.customerName ||
      body?.customerName ||
      null,
    contentUrl:
      payment?.metadata?.contentUrl ||
      body?.metadata?.contentUrl ||
      null,
    paymentId: payment?.id || body?.id || null,
    raw: body
  };
}

module.exports = {
  createPayment,
  normalizePaidWebhook,
  verifyWebhookSecret,
  createOrderId
};
