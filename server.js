// Atlas — backend de proxy para a API da Mistral
// A chave da Mistral fica só aqui no servidor (variável de ambiente),
// nunca é enviada ao navegador de quem usa o site.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const ALLOWED_MODELS = new Set([
  'mistral-large-latest',
  'mistral-medium-latest',
  'mistral-small-latest',
  'codestral-latest'
]);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
  try {
    if (!MISTRAL_API_KEY) {
      return res.status(500).json({
        error: 'Servidor sem chave configurada. Defina a variável de ambiente MISTRAL_API_KEY no Render.'
      });
    }

    const { messages, model } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Requisição inválida: "messages" é obrigatório.' });
    }

    const safeModel = ALLOWED_MODELS.has(model) ? model : 'mistral-large-latest';

    const mistralResp = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: safeModel,
        messages,
        temperature: 0.3
      })
    });

    const data = await mistralResp.json();

    if (!mistralResp.ok) {
      return res.status(mistralResp.status).json({
        error: data.message || data.error || 'Erro ao chamar a API da Mistral.'
      });
    }

    const reply = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;

    if (!reply) {
      return res.status(502).json({ error: 'Resposta da Mistral em formato inesperado.' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('Erro no /api/chat:', err);
    res.status(500).json({ error: 'Erro interno no servidor: ' + err.message });
  }
});

// Qualquer outra rota GET cai no index.html (SPA simples)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Atlas rodando na porta ${PORT}`);
});
