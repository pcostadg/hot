'use strict';

const axios = require('axios');

function normalizePhone(number) {
  if (!number) return '';

  return String(number)
    .replace(/\D/g, '')
    .replace(/^0+/, '');
}

function withWhatsAppSuffix(number) {
  const normalized = normalizePhone(number);
  if (!normalized) return '';

  return normalized.includes('@s.whatsapp.net')
    ? normalized
    : `${normalized}@s.whatsapp.net`;
}

function buildEvolutionClient() {
  const baseURL = process.env.EVOLUTION_BASE_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;

  if (!baseURL) {
    throw new Error('EVOLUTION_BASE_URL is required');
  }

  if (!apiKey) {
    throw new Error('EVOLUTION_API_KEY is required');
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

async function sendText({ instance, number, text, delay = 1200, presence = 'composing' }) {
  const client = buildEvolutionClient();
  const targetNumber = normalizePhone(number);

  if (!instance) throw new Error('Evolution instance is required');
  if (!targetNumber) throw new Error('Target number is required');
  if (!text) throw new Error('Text content is required');

  const response = await client.post(`/message/sendText/${encodeURIComponent(instance)}`, {
    number: targetNumber,
    options: {
      delay,
      presence
    },
    textMessage: {
      text: String(text)
    }
  });

  return response.data;
}

async function sendMedia({
  instance,
  number,
  media,
  mediatype = 'image',
  mimetype,
  caption = '',
  fileName,
  delay = 1200,
  linkPreview = false
}) {
  const client = buildEvolutionClient();
  const targetNumber = normalizePhone(number);

  if (!instance) throw new Error('Evolution instance is required');
  if (!targetNumber) throw new Error('Target number is required');
  if (!media) throw new Error('Media URL or base64 content is required');

  const payload = {
    number: targetNumber,
    mediatype,
    media: String(media),
    caption: caption ? String(caption) : undefined,
    fileName: fileName ? String(fileName) : undefined,
    mimetype,
    delay,
    linkPreview
  };

  const response = await client.post(`/message/sendMedia/${encodeURIComponent(instance)}`, payload);
  return response.data;
}

module.exports = {
  sendText,
  sendMedia,
  normalizePhone,
  withWhatsAppSuffix
};
