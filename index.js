'use strict';

require('dotenv').config();

const express = require('express');
const { sendText, sendMedia, normalizePhone } = require('./services/evolutionApi');
const {
  createPayment,
  normalizePaidWebhook,
  verifyWebhookSecret,
  createOrderId
} = require('./services/sigiloPay');

const app = express();
const port = Number(process.env.PORT || 3000);
const evolutionInstance = process.env.EVOLUTION_INSTANCE_NAME;
const botFlowMode = String(process.env.BOT_FLOW_MODE || 'test').toLowerCase();

app.use(express.json({ limit: '10mb' }));

// Em produção, este bot precisa de persistência externa.
// O mapa abaixo cobre o fluxo básico enquanto o processo está ativo.
const pendingOrders = new Map();
const customerSessions = new Map();

function parseMoney(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getProductConfig() {
  return {
    name: process.env.BOT_PRODUCT_NAME || 'Conteudo Premium',
    description: process.env.BOT_PRODUCT_DESCRIPTION || 'Acesso ao conteudo premium via WhatsApp',
    amount: parseMoney(process.env.BOT_PRODUCT_PRICE, 29.9),
    currency: process.env.BOT_PRODUCT_CURRENCY || 'BRL',
    contentUrl: process.env.BOT_CONTENT_URL || '',
    testContentUrl: process.env.BOT_TEST_CONTENT_URL || process.env.BOT_CONTENT_URL || '',
    previewImageUrl: process.env.BOT_PREVIEW_IMAGE_URL || '',
    previewVideoUrl: process.env.BOT_PREVIEW_VIDEO_URL || '',
    previewMediaType: process.env.BOT_PREVIEW_MEDIA_TYPE || 'image',
    previewMediaCaption:
      process.env.BOT_PREVIEW_MEDIA_CAPTION || 'Confira uma previa do conteudo antes da compra.'
  };
}

function extractIncomingMessage(payload) {
  const wrapper = payload?.data || payload;
  const message =
    wrapper?.messages?.[0] ||
    wrapper?.message ||
    wrapper?.data?.messages?.[0] ||
    wrapper?.data?.message ||
    null;

  const key = message?.key || wrapper?.key || null;
  const fromMe = Boolean(key?.fromMe);

  const remoteJid =
    key?.remoteJid ||
    wrapper?.remoteJid ||
    wrapper?.sender ||
    wrapper?.from ||
    '';

  const text =
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    wrapper?.message?.conversation ||
    wrapper?.message?.extendedTextMessage?.text ||
    wrapper?.text ||
    '';

  return {
    remoteJid,
    fromMe,
    messageId: key?.id || message?.messageId || wrapper?.id || null,
    text: String(text || '').trim(),
    raw: payload
  };
}

function getBasePhone(remoteJid) {
  return normalizePhone(remoteJid);
}

function buildWelcomeMessage(product) {
  return [
    `Olá! Eu sou o assistente de vendas do ${process.env.BOT_SUPPORT_NAME || 'time'}.`,
    '',
    `Produto: ${product.name}`,
    `Valor: R$ ${product.amount.toFixed(2)}`,
    '',
    'Responda com:',
    '1 - Ver previa e gerar PIX',
    '2 - Falar com suporte',
    '',
    'Se quiser comprar agora, envie "1".'
  ].join('\n');
}

function buildPixMessage(payment, product) {
  const lines = [
    `Pagamento gerado para ${product.name}.`,
    `Valor: R$ ${payment.amount.toFixed(2)}`,
    ''
  ];

  if (payment.pixCopyPaste) {
    lines.push('PIX Copia e Cola:');
    lines.push(String(payment.pixCopyPaste));
    lines.push('');
  }

  if (payment.qrCode) {
    lines.push('QR Code do PIX:');
    lines.push(String(payment.qrCode));
    lines.push('');
  }

  if (payment.checkoutUrl) {
    lines.push('Link de pagamento:');
    lines.push(String(payment.checkoutUrl));
    lines.push('');
  }

  lines.push('Assim que o pagamento for confirmado, eu libero automaticamente o conteudo.');

  return lines.join('\n');
}

function buildTestFlowMessage(product) {
  return [
    `Fluxo de teste ativo para ${product.name}.`,
    '',
    'Neste modo nao geramos PIX real.',
    'A proxima mensagem mostra a previa e o link de teste.',
    '',
    'Quando quiser ativar o fluxo real, altere BOT_FLOW_MODE para production.'
  ].join('\n');
}

async function sendProductPreview(number, product) {
  const mediaUrl = product.previewVideoUrl || product.previewImageUrl;

  if (!mediaUrl) return null;

  return sendMedia({
    instance: evolutionInstance,
    number,
    media: mediaUrl,
    mediatype: product.previewVideoUrl ? 'video' : product.previewMediaType,
    caption: product.previewMediaCaption,
    fileName: product.previewVideoUrl ? 'preview.mp4' : 'preview.jpg',
    linkPreview: false
  });
}

async function createAndSendPayment(number, product, customerName) {
  const orderId = createOrderId();
  const payment = await createPayment({
    orderId,
    customerName: customerName || 'Cliente',
    customerPhone: number,
    amount: product.amount,
    description: product.description,
    contentUrl: product.contentUrl,
    metadata: {
      productName: product.name,
      customerPhone: number,
      customerName: customerName || 'Cliente'
    }
  });

  pendingOrders.set(orderId, {
    orderId,
    number,
    product,
    paymentId: payment.paymentId,
    createdAt: new Date().toISOString()
  });

  return payment;
}

async function sendTestDelivery(number, product) {
  const contentUrl = product.testContentUrl || product.contentUrl;

  await sendText({
    instance: evolutionInstance,
    number,
    text: [
      'Fluxo de teste concluido com sucesso.',
      '',
      'Abaixo esta o link temporario de entrega para validacao:',
      contentUrl || 'Nenhum link configurado em BOT_TEST_CONTENT_URL'
    ].join('\n')
  });
}

async function handleSalesFlow(message) {
  const product = getProductConfig();
  const number = getBasePhone(message.remoteJid);
  const incomingText = message.text.toLowerCase();
  const session = customerSessions.get(number) || { stage: 'new' };
  const isGreeting = /^(oi|ol[aá]|ola|bom dia|boa tarde|boa noite|menu|iniciar|start)$/i.test(incomingText);
  const wantsSales =
    incomingText === '1' ||
    isGreeting ||
    /comprar|quero|pix|preco|preço|valor|link/i.test(incomingText);

  if (!number) return;

  if (incomingText === '2' || /suporte|atendente|humano/i.test(incomingText)) {
    await sendText({
      instance: evolutionInstance,
      number,
      text: [
        'Perfeito. Um atendente humano pode continuar com voce.',
        `Enquanto isso, responda com "1" para ver a previa e gerar o PIX do ${product.name}.`
      ].join('\n')
    });

    customerSessions.set(number, { stage: 'support' });
    return;
  }

  if (wantsSales || session.stage === 'menu_sent') {
    customerSessions.set(number, { stage: 'offer_sent' });

    await sendText({
      instance: evolutionInstance,
      number,
      text: buildWelcomeMessage(product)
    });

    await sendProductPreview(number, product);

    if (botFlowMode === 'test') {
      await sendText({
        instance: evolutionInstance,
        number,
        text: buildTestFlowMessage(product)
      });

      await sendTestDelivery(number, product);

      customerSessions.set(number, {
        stage: 'test_completed',
        orderId: null
      });
      return;
    }

    const payment = await createAndSendPayment(number, product, message.pushName || 'Cliente');

    await sendText({
      instance: evolutionInstance,
      number,
      text: buildPixMessage(payment, product)
    });

    customerSessions.set(number, {
      stage: 'awaiting_payment',
      orderId: payment.orderId
    });
    return;
  }

  await sendText({
    instance: evolutionInstance,
    number,
    text: 'Nao entendi sua mensagem. Responda com "1" para gerar o PIX ou "2" para suporte.'
  });
}

async function deliverContentForPaidOrder({ orderId, number, contentUrl, customerName }) {
  const order = orderId ? pendingOrders.get(orderId) : null;
  const targetNumber = normalizePhone(number || order?.number);
  const targetContentUrl = contentUrl || order?.product?.contentUrl || process.env.BOT_CONTENT_URL;
  const productName = order?.product?.name || process.env.BOT_PRODUCT_NAME || 'Conteudo Premium';

  if (!targetNumber) {
    throw new Error('Unable to determine customer phone for delivery');
  }

  if (!targetContentUrl) {
    throw new Error('No content URL configured for delivery');
  }

  await sendText({
    instance: evolutionInstance,
    number: targetNumber,
    text: [
      'Pagamento confirmado com sucesso.',
      customerName ? `Obrigado, ${customerName}.` : 'Obrigado pela compra.',
      '',
      `Aqui está seu acesso ao ${productName}:`,
      targetContentUrl
    ].join('\n')
  });

  if (orderId) {
    pendingOrders.delete(orderId);
  }

  customerSessions.set(targetNumber, {
    stage: 'delivered',
    orderId: orderId || null
  });
}

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'whatsapp-sales-bot',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook/evolution', async (req, res) => {
  try {
    const incoming = extractIncomingMessage(req.body);

    if (!incoming.remoteJid || incoming.fromMe || !incoming.text) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!evolutionInstance) {
      throw new Error('EVOLUTION_INSTANCE_NAME is required');
    }

    await handleSalesFlow({
      remoteJid: incoming.remoteJid,
      text: incoming.text,
      pushName: req.body?.pushName || req.body?.data?.pushName || null
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error on /webhook/evolution:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/webhook/sigilo', async (req, res) => {
  try {
    if (botFlowMode === 'test') {
      return res.status(200).json({ ok: true, ignored: true, reason: 'test mode active' });
    }

    if (!verifyWebhookSecret(req)) {
      return res.status(401).json({ ok: false, error: 'Invalid webhook secret' });
    }

    const paymentEvent = normalizePaidWebhook(req.body);

    if (!paymentEvent.isPaid) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (!evolutionInstance) {
      throw new Error('EVOLUTION_INSTANCE_NAME is required');
    }

    await deliverContentForPaidOrder({
      orderId: paymentEvent.orderId,
      number: paymentEvent.customerPhone,
      contentUrl: paymentEvent.contentUrl,
      customerName: paymentEvent.customerName
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error on /webhook/sigilo:', error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Route not found' });
});

app.listen(port, () => {
  console.log(`WhatsApp sales bot running on port ${port}`);
});
