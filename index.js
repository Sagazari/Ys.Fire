require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const initSqlJs = require('sql.js');
const {
  Client, GatewayIntentBits, Partials,
  REST, Routes, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ComponentType, ActivityType,
} = require('discord.js');

// ─────────────────────────────────────────────────────────────
// DATABASE (sql.js — puro JS, sem compilação nativa)
// ─────────────────────────────────────────────────────────────
if (!fs.existsSync('./data')) fs.mkdirSync('./data');
const DB_PATH = './data/sentinela.db';
let db;

function dbRun(sql, params = []) { db.run(sql, params); saveDb(); }
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return undefined;
}
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = []; while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
function saveDb() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

async function initDb() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY, username TEXT, aura INTEGER DEFAULT 0, aura_total INTEGER DEFAULT 0,
      last_daily TEXT DEFAULT NULL, last_trabalho TEXT DEFAULT NULL, last_crime TEXT DEFAULT NULL,
      last_roubo TEXT DEFAULT NULL, nivel INTEGER DEFAULT 1, xp INTEGER DEFAULT 0,
      casado_com TEXT DEFAULT NULL, data_casamento TEXT DEFAULT NULL,
      mortes INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inventario (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item TEXT NOT NULL, quantidade INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE, channel_id TEXT, guild_id TEXT,
      premio TEXT, aura INTEGER DEFAULT 0, host_id TEXT, vencedores INTEGER DEFAULT 1,
      termina_em TEXT, ativo INTEGER DEFAULT 1, criado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS giveaway_participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, giveaway_id INTEGER, user_id TEXT, UNIQUE(giveaway_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shop (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT UNIQUE, descricao TEXT, preco INTEGER, emoji TEXT, ativo INTEGER DEFAULT 1
    );
  `);

  for (const i of [
    { nome: 'Escudo de Aura',    descricao: 'Protege contra roubo por 24h',        preco: 500,  emoji: '🛡️' },
    { nome: 'Amuleto da Sorte',  descricao: 'Dobra o ganho do Daily por 1 dia',     preco: 800,  emoji: '🍀' },
    { nome: 'Capa do Ladrão',    descricao: 'Aumenta chances no crime por 24h',     preco: 1200, emoji: '🥷' },
    { nome: 'Poção de XP',       descricao: 'Ganha 500 XP instantaneamente',        preco: 300,  emoji: '⚗️' },
    { nome: 'Anel de Casamento', descricao: 'Necessário para se casar',             preco: 2000, emoji: '💍' },
    { nome: 'Ticket de Sorte',   descricao: 'Aumenta suas chances no giveaway',     preco: 150,  emoji: '🎟️' },
    { nome: 'Elixir de Aura',    descricao: 'Ganha 1000 de Aura na hora',          preco: 900,  emoji: '✨' },
    { nome: 'Buquê de Flores',   descricao: 'Para presentear alguém especial',     preco: 200,  emoji: '💐' },
  ]) db.run(`INSERT OR IGNORE INTO shop (nome, descricao, preco, emoji) VALUES (?, ?, ?, ?)`, [i.nome, i.descricao, i.preco, i.emoji]);

  saveDb();
}

// ─── DB Helpers ───────────────────────────────────────────────
function getUser(id, username = '') {
  let u = dbGet('SELECT * FROM usuarios WHERE id = ?', [id]);
  if (!u) { dbRun('INSERT OR IGNORE INTO usuarios (id, username) VALUES (?, ?)', [id, username]); u = dbGet('SELECT * FROM usuarios WHERE id = ?', [id]); }
  return u;
}
function addAura(id, qt) { dbRun('UPDATE usuarios SET aura = aura + ?, aura_total = aura_total + ? WHERE id = ?', [qt, qt > 0 ? qt : 0, id]); }
function removeAura(id, qt) { const u = getUser(id); const r = Math.min(qt, u.aura); dbRun('UPDATE usuarios SET aura = aura - ? WHERE id = ?', [r, id]); return r; }
function addXP(id, xp) {
  const u = getUser(id); let novoXP = u.xp + xp, novoNivel = u.nivel;
  if (novoXP >= novoNivel * 500) { novoXP -= novoNivel * 500; novoNivel++; }
  dbRun('UPDATE usuarios SET xp = ?, nivel = ? WHERE id = ?', [novoXP, novoNivel, id]);
  return { levelUp: novoNivel > u.nivel, novoNivel };
}
function getRanking(limit = 10) { return dbAll('SELECT * FROM usuarios ORDER BY aura DESC LIMIT ?', [limit]); }
function getInventario(uid) { return dbAll('SELECT * FROM inventario WHERE user_id = ?', [uid]); }
function addItem(uid, item) {
  const ex = dbGet('SELECT * FROM inventario WHERE user_id = ? AND item = ?', [uid, item]);
  if (ex) dbRun('UPDATE inventario SET quantidade = quantidade + 1 WHERE user_id = ? AND item = ?', [uid, item]);
  else dbRun('INSERT INTO inventario (user_id, item) VALUES (?, ?)', [uid, item]);
}
function removeItem(uid, item) {
  const ex = dbGet('SELECT * FROM inventario WHERE user_id = ? AND item = ?', [uid, item]);
  if (!ex) return false;
  if (ex.quantidade <= 1) dbRun('DELETE FROM inventario WHERE user_id = ? AND item = ?', [uid, item]);
  else dbRun('UPDATE inventario SET quantidade = quantidade - 1 WHERE user_id = ? AND item = ?', [uid, item]);
  return true;
}
function hasItem(uid, item) { return !!dbGet('SELECT * FROM inventario WHERE user_id = ? AND item = ?', [uid, item]); }

// ─────────────────────────────────────────────────────────────
// COMANDOS
// ─────────────────────────────────────────────────────────────
const commands = [];

// ─── /daily ──────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('daily').setDescription('🌟 Colete sua Aura diária!'),
  async execute(interaction) {
    const user = getUser(interaction.user.id, interaction.user.username);
    const agora = new Date();
    const ultimo = user.last_daily ? new Date(user.last_daily) : null;
    const CD = 20 * 3600000;
    if (ultimo && agora - ultimo < CD) {
      const rest = new Date(ultimo.getTime() + CD - agora);
      const h = Math.floor(rest / 3600000), m = Math.floor((rest % 3600000) / 60000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('⏰ Calma aí!').setDescription(`Volte em **${h}h ${m}m**.`).setThumbnail(interaction.user.displayAvatarURL()).setFooter({ text: 'Sentinela • Daily' })] });
    }
    const temAmuleto = hasItem(interaction.user.id, 'Amuleto da Sorte');
    let base = Math.floor(Math.random() * 500) + 750;
    if (temAmuleto) base *= 2;
    const bonus = Math.random() < 0.1 ? Math.floor(Math.random() * 500) + 200 : 0;
    const total = base + bonus;
    addAura(interaction.user.id, total);
    const { levelUp, novoNivel } = addXP(interaction.user.id, 100);
    dbRun('UPDATE usuarios SET last_daily = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    const ua = getUser(interaction.user.id);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('✨ Aura Coletada!').setDescription(`${interaction.user}, você coletou sua Aura do dia!`).addFields({ name: '✨ Aura Recebida', value: `**+${total.toLocaleString('pt-BR')}**${bonus > 0 ? ` (🎉 Bônus: +${bonus})` : ''}`, inline: true }, { name: '💰 Aura Total', value: `**${ua.aura.toLocaleString('pt-BR')}**`, inline: true }, { name: '⭐ XP', value: `**+100 XP**${levelUp ? ` → Nível **${novoNivel}**! 🎊` : ''}`, inline: true }).setThumbnail(interaction.user.displayAvatarURL()).setFooter({ text: temAmuleto ? '🍀 Amuleto da Sorte ativo!' : 'Sentinela • Daily' }).setTimestamp()] });
  },
});

// ─── /trabalho ───────────────────────────────────────────────
const trabalhos = [
  { nome: 'Pizzaiolo',   emoji: '🍕', frase: 'Você fez 15 pizzas e recebeu',          min: 100, max: 300 },
  { nome: 'Streamer',    emoji: '🎮', frase: 'Você ficou ao vivo por 2h e recebeu',   min: 150, max: 400 },
  { nome: 'Médico',      emoji: '🏥', frase: 'Você salvou 3 vidas hoje e recebeu',    min: 200, max: 500 },
  { nome: 'Youtuber',    emoji: '📹', frase: 'Seu vídeo viralizou e você recebeu',    min: 200, max: 600 },
  { nome: 'Programador', emoji: '💻', frase: 'Você consertou um bug crítico e recebeu', min: 250, max: 550 },
  { nome: 'Chef',        emoji: '👨‍🍳', frase: 'Você preparou um banquete e recebeu',  min: 150, max: 350 },
  { nome: 'Astronauta',  emoji: '🚀', frase: 'Você viajou ao espaço e recebeu',       min: 300, max: 700 },
  { nome: 'Detetive',    emoji: '🕵️', frase: 'Você resolveu um crime e recebeu',      min: 200, max: 500 },
  { nome: 'Surfista',    emoji: '🏄', frase: 'Você ganhou um campeonato e recebeu',   min: 180, max: 450 },
];
commands.push({
  data: new SlashCommandBuilder().setName('trabalho').setDescription('💼 Trabalhe para ganhar Aura'),
  async execute(interaction) {
    const user = getUser(interaction.user.id, interaction.user.username);
    const agora = new Date();
    const ultimo = user.last_trabalho ? new Date(user.last_trabalho) : null;
    if (ultimo && agora - ultimo < 3600000) {
      const rest = new Date(ultimo.getTime() + 3600000 - agora);
      const m = Math.floor(rest / 60000), s = Math.floor((rest % 60000) / 1000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('⏰ Você está cansado!').setDescription(`Descanse um pouco. Trabalhe em **${m}m ${s}s**.`).setFooter({ text: 'Sentinela • Trabalho' })] });
    }
    const t = trabalhos[Math.floor(Math.random() * trabalhos.length)];
    const ganho = Math.floor(Math.random() * (t.max - t.min + 1)) + t.min;
    addAura(interaction.user.id, ganho);
    addXP(interaction.user.id, 50);
    dbRun('UPDATE usuarios SET last_trabalho = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`${t.emoji} Trabalho: ${t.nome}`).setDescription(`${t.frase} **+${ganho.toLocaleString('pt-BR')} ✨ Aura**!`).addFields({ name: '⭐ XP', value: '+50 XP', inline: true }).setFooter({ text: 'Sentinela • Trabalho • CD: 1h' }).setTimestamp()] });
  },
});

// ─── /crime ──────────────────────────────────────────────────
const crimes = [
  { nome: 'Hackeou o banco central',          emoji: '💻', min: 500,  max: 1500 },
  { nome: 'Roubou uma loja de eletrônicos',   emoji: '📱', min: 200,  max: 700  },
  { nome: 'Falsificou documentos',            emoji: '📄', min: 150,  max: 500  },
  { nome: 'Contrabandeou memes raros',        emoji: '😂', min: 100,  max: 400  },
  { nome: 'Assaltou uma padaria',             emoji: '🥐', min: 50,   max: 200  },
  { nome: 'Vendeu segredos da NASA',          emoji: '🚀', min: 800,  max: 2000 },
];
const falhasCrime = [
  'Você escorregou na casca de banana ao fugir 🍌',
  'A câmera de segurança te filmou dançando antes do crime 📸',
  'Você esqueceu a carteira no local do crime 👛',
  'Você foi reconhecido por ser famoso no Discord 😭',
];
commands.push({
  data: new SlashCommandBuilder().setName('crime').setDescription('🦹 Tente a sorte no crime (arriscado!)'),
  async execute(interaction) {
    const user = getUser(interaction.user.id, interaction.user.username);
    const agora = new Date();
    const ultimo = user.last_crime ? new Date(user.last_crime) : null;
    const CD = 2 * 3600000;
    if (ultimo && agora - ultimo < CD) {
      const rest = new Date(ultimo.getTime() + CD - agora);
      const h = Math.floor(rest / 3600000), m = Math.floor((rest % 3600000) / 60000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🚓 A polícia ainda está te procurando!').setDescription(`Espere **${h}h ${m}m**.`).setFooter({ text: 'Sentinela • Crime' })] });
    }
    const temCapa = hasItem(interaction.user.id, 'Capa do Ladrão');
    const sucesso = Math.random() < (temCapa ? 0.65 : 0.50);
    const crime = crimes[Math.floor(Math.random() * crimes.length)];
    dbRun('UPDATE usuarios SET last_crime = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    if (sucesso) {
      const ganho = Math.floor(Math.random() * (crime.max - crime.min + 1)) + crime.min;
      addAura(interaction.user.id, ganho);
      addXP(interaction.user.id, 75);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`${crime.emoji} Crime bem-sucedido!`).setDescription(`Você **${crime.nome}** e ninguém te viu!\n\n💰 Ganhou **+${ganho.toLocaleString('pt-BR')} ✨ Aura**!`).setFooter({ text: `Sentinela • Crime${temCapa ? ' • 🥷 Capa ativa' : ''}` }).setTimestamp()] });
    } else {
      const multa = Math.floor(Math.random() * 300) + 100;
      removeAura(interaction.user.id, multa);
      dbRun('UPDATE usuarios SET mortes = mortes + 1 WHERE id = ?', [interaction.user.id]);
      const falha = falhasCrime[Math.floor(Math.random() * falhasCrime.length)];
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('🚔 Você foi preso!').setDescription(`${falha}\n\nPagou **-${multa} ✨ Aura** de fiança.`).setFooter({ text: 'Sentinela • Crime' }).setTimestamp()] });
    }
  },
});

// ─── /roubar ─────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('roubar').setDescription('🥷 Tente roubar a Aura de alguém').addUserOption(o => o.setName('alvo').setDescription('Quem roubar').setRequired(true)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('alvo');
    if (alvo.id === interaction.user.id) return interaction.reply({ content: '🤦 Você não pode se roubar!', ephemeral: true });
    if (alvo.bot) return interaction.reply({ content: '🤖 Roubar bot?', ephemeral: true });
    const user = getUser(interaction.user.id, interaction.user.username);
    const vitima = getUser(alvo.id, alvo.username);
    const agora = new Date();
    const ultimo = user.last_roubo ? new Date(user.last_roubo) : null;
    const CD = 3 * 3600000;
    if (ultimo && agora - ultimo < CD) {
      const rest = new Date(ultimo.getTime() + CD - agora);
      const h = Math.floor(rest / 3600000), m = Math.floor((rest % 3600000) / 60000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('⏰ Cooldown').setDescription(`Espere **${h}h ${m}m**.`)] });
    }
    if (vitima.aura < 100) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('😭 Alvo pobre!').setDescription(`${alvo.username} tem menos de 100 Aura.`)] });
    if (hasItem(alvo.id, 'Escudo de Aura')) {
      dbRun('UPDATE usuarios SET last_roubo = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🛡️ Bloqueado!').setDescription(`${alvo.username} está protegido por um **Escudo de Aura**!`)] });
    }
    dbRun('UPDATE usuarios SET last_roubo = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    if (Math.random() < 0.45) {
      const pct = Math.random() * 0.25 + 0.05;
      const roubado = Math.floor(vitima.aura * pct);
      removeAura(alvo.id, roubado);
      addAura(interaction.user.id, roubado);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('🥷 Roubo bem-sucedido!').setDescription(`Você roubou **${roubado.toLocaleString('pt-BR')} ✨ Aura** de ${alvo}!`).setFooter({ text: 'Sentinela • Roubo' }).setTimestamp()] });
    } else {
      const multa = Math.floor(Math.random() * 200) + 100;
      removeAura(interaction.user.id, multa);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('🚨 Flagrado!').setDescription(`${alvo} te pegou! Pagou **-${multa} ✨ Aura** de indenização.`).setFooter({ text: 'Sentinela • Roubo' }).setTimestamp()] });
    }
  },
});

// ─── /transferir ─────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('transferir').setDescription('💸 Transfira Aura para outro usuário').addUserOption(o => o.setName('usuario').setDescription('Quem vai receber').setRequired(true)).addIntegerOption(o => o.setName('quantidade').setDescription('Quanto').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const qt = interaction.options.getInteger('quantidade');
    if (alvo.id === interaction.user.id) return interaction.reply({ content: '🤦 Não pode transferir para si mesmo!', ephemeral: true });
    if (alvo.bot) return interaction.reply({ content: '🤖 Bots não aceitam Aura.', ephemeral: true });
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < qt) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Aura insuficiente!').setDescription(`Você tem apenas **${user.aura.toLocaleString('pt-BR')} ✨**.`)] });
    getUser(alvo.id, alvo.username);
    removeAura(interaction.user.id, qt);
    addAura(alvo.id, qt);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('💸 Transferência realizada!').setDescription(`**${interaction.user.username}** enviou **${qt.toLocaleString('pt-BR')} ✨ Aura** para ${alvo}!`).setFooter({ text: 'Sentinela • Transferência' }).setTimestamp()] });
  },
});

// ─── /perfil ─────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('perfil').setDescription('👤 Veja seu perfil ou de outro usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const user = getUser(alvo.id, alvo.username);
    const xpNec = user.nivel * 500;
    const bar = '█'.repeat(Math.floor((user.xp / xpNec) * 10)) + '░'.repeat(10 - Math.floor((user.xp / xpNec) * 10));
    const medalha = user.nivel >= 50 ? '👑' : user.nivel >= 30 ? '💎' : user.nivel >= 20 ? '🥇' : user.nivel >= 10 ? '🥈' : '🥉';
    const casado = user.casado_com ? `💒 Casado(a) com <@${user.casado_com}>` : '💔 Solteiro(a)';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`${medalha} Perfil de ${alvo.username}`).setThumbnail(alvo.displayAvatarURL({ size: 256 })).addFields({ name: '✨ Aura', value: `**${user.aura.toLocaleString('pt-BR')}**`, inline: true }, { name: '🏆 Aura Total', value: `**${user.aura_total.toLocaleString('pt-BR')}**`, inline: true }, { name: '⭐ Nível', value: `**${user.nivel}**`, inline: true }, { name: `📊 XP [${bar}]`, value: `${user.xp} / ${xpNec}`, inline: false }, { name: '💍 Status', value: casado, inline: false }).setFooter({ text: 'Sentinela • Perfil' }).setTimestamp()] });
  },
});

// ─── /ranking ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('ranking').setDescription('🏆 Top 10 de Aura do servidor'),
  async execute(interaction) {
    await interaction.deferReply();
    const top = getRanking(10);
    if (!top.length) return interaction.editReply('Nenhum usuário registrado!');
    const medalhas = ['🥇', '🥈', '🥉'];
    const linhas = await Promise.all(top.map(async (u, i) => {
      let nome;
      try { const m = await interaction.guild.members.fetch(u.id).catch(() => null); nome = m ? m.displayName : u.username || 'Usuário'; } catch { nome = u.username || 'Usuário'; }
      return `${medalhas[i] || `**${i + 1}.**`} **${nome}** — ✨ ${u.aura.toLocaleString('pt-BR')} Aura`;
    }));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Ranking de Aura').setDescription(linhas.join('\n')).setFooter({ text: 'Sentinela • Top 10' }).setTimestamp()] });
  },
});

// ─── /loja ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('loja').setDescription('🛒 Veja os itens da loja'),
  async execute(interaction) {
    const itens = dbAll('SELECT * FROM shop WHERE ativo = 1', []);
    const user = getUser(interaction.user.id);
    const linhas = itens.map(i => `${i.emoji} **${i.nome}** — \`${i.preco.toLocaleString('pt-BR')} ✨\`\n> ${i.descricao}`).join('\n\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🛒 Loja da Aura').setDescription(linhas).addFields({ name: '💰 Sua Aura', value: `**${user.aura.toLocaleString('pt-BR')}**`, inline: true }).setFooter({ text: 'Use /comprar <item> • Sentinela' }).setTimestamp()] });
  },
});

// ─── /comprar ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('comprar').setDescription('💳 Compre um item da loja').addStringOption(o => o.setName('item').setDescription('Nome do item').setRequired(true)),
  async execute(interaction) {
    const nome = interaction.options.getString('item');
    const item = dbGet('SELECT * FROM shop WHERE LOWER(nome) = LOWER(?) AND ativo = 1', [nome]);
    if (!item) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Item não encontrado!').setDescription('Use **/loja** para ver os itens.')], ephemeral: true });
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < item.preco) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Aura insuficiente!').setDescription(`Você precisa de **${item.preco.toLocaleString('pt-BR')} ✨** mas tem **${user.aura.toLocaleString('pt-BR')} ✨**.`)], ephemeral: true });
    removeAura(interaction.user.id, item.preco);
    if (item.nome === 'Elixir de Aura') addAura(interaction.user.id, 1000);
    else addItem(interaction.user.id, item.nome);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`${item.emoji} Compra realizada!`).setDescription(`Você comprou **${item.nome}** por **${item.preco.toLocaleString('pt-BR')} ✨**!`).setFooter({ text: item.nome === 'Elixir de Aura' ? '✨ +1000 Aura adicionados!' : 'Item no inventário!' }).setTimestamp()] });
  },
});

// ─── /inventario ─────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('inventario').setDescription('🎒 Veja seu inventário'),
  async execute(interaction) {
    const inv = getInventario(interaction.user.id);
    const embed = new EmbedBuilder().setColor('#7B2FBE').setTitle(`🎒 Inventário de ${interaction.user.username}`).setThumbnail(interaction.user.displayAvatarURL()).setFooter({ text: 'Sentinela • Inventário' }).setTimestamp();
    if (!inv.length) embed.setDescription('Seu inventário está vazio!\nCompre itens na **/loja**.');
    else {
      const linhas = inv.map(i => { const s = dbGet('SELECT emoji FROM shop WHERE nome = ?', [i.item]); return `${s?.emoji || '📦'} **${i.item}** x${i.quantidade}`; }).join('\n');
      embed.setDescription(linhas);
    }
    await interaction.reply({ embeds: [embed] });
  },
});

// ─── /apostar (slots) ────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('apostar').setDescription('🎰 Aposte sua Aura no caça-níquel!').addIntegerOption(o => o.setName('quantidade').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const aposta = interaction.options.getInteger('quantidade');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Aura insuficiente!').setDescription(`Você tem apenas **${user.aura.toLocaleString('pt-BR')} ✨**`)], ephemeral: true });
    const simbolos = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
    const pesos = [35, 25, 20, 10, 5, 3, 2];
    function getSim() { const t = pesos.reduce((a, b) => a + b, 0); let r = Math.random() * t; for (let i = 0; i < simbolos.length; i++) { r -= pesos[i]; if (r <= 0) return simbolos[i]; } return simbolos[0]; }
    const [s1, s2, s3] = [getSim(), getSim(), getSim()];
    let mult = 0, msg = '';
    if (s1 === s2 && s2 === s3) { if (s1 === '7️⃣') { mult = 10; msg = '🎊 **JACKPOT! TRIO DE 7!**'; } else if (s1 === '💎') { mult = 7; msg = '💎 **TRIO DE DIAMANTES!**'; } else if (s1 === '⭐') { mult = 5; msg = '⭐ **TRIO DE ESTRELAS!**'; } else { mult = 3; msg = '🎉 **TRIO!**'; } }
    else if (s1 === s2 || s2 === s3 || s1 === s3) { mult = 1.5; msg = '✨ **PAR!**'; }
    else { mult = 0; msg = '😢 **Não foi dessa vez...**'; }
    let ganho = 0; let cor = '#FF6B6B';
    if (mult > 0) { ganho = Math.floor(aposta * mult); addAura(interaction.user.id, ganho - aposta); cor = '#00C851'; }
    else { removeAura(interaction.user.id, aposta); ganho = -aposta; }
    const ua = getUser(interaction.user.id);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(cor).setTitle('🎰 Caça-Níquel').setDescription(`[ ${s1} | ${s2} | ${s3} ]\n\n${msg}`).addFields({ name: '💰 Aposta', value: `${aposta.toLocaleString('pt-BR')} ✨`, inline: true }, { name: ganho >= 0 ? '📈 Ganho' : '📉 Perda', value: `${ganho >= 0 ? '+' : ''}${ganho.toLocaleString('pt-BR')} ✨`, inline: true }, { name: '💼 Aura Atual', value: `${ua.aura.toLocaleString('pt-BR')} ✨`, inline: true }).setFooter({ text: 'Sentinela • Slots' }).setTimestamp()] });
  },
});

// ─── /ship ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('ship').setDescription('💘 Dê ship em duas pessoas!').addUserOption(o => o.setName('pessoa1').setDescription('Primeira pessoa').setRequired(true)).addUserOption(o => o.setName('pessoa2').setDescription('Segunda pessoa').setRequired(false)),
  async execute(interaction) {
    const p1 = interaction.options.getUser('pessoa1');
    const p2 = interaction.options.getUser('pessoa2') || interaction.user;
    const pct = Number((BigInt(p1.id) + BigInt(p2.id)) % 101n);
    const bar = '❤️'.repeat(Math.floor(pct / 10)) + '🖤'.repeat(10 - Math.floor(pct / 10));
    let nivel, cor;
    if (pct >= 90) { nivel = 'Almas gêmeas! 💞'; cor = '#FF1493'; }
    else if (pct >= 75) { nivel = 'Muito compatíveis! 💕'; cor = '#FF69B4'; }
    else if (pct >= 60) { nivel = 'Boa química! 💗'; cor = '#FF6B6B'; }
    else if (pct >= 40) { nivel = 'Pode dar certo! 💛'; cor = '#FFD700'; }
    else if (pct >= 20) { nivel = 'Hmm... talvez? 🧡'; cor = '#FFA500'; }
    else { nivel = 'Melhor como amigos 😅 💔'; cor = '#808080'; }
    const nome = p1.username.slice(0, Math.ceil(p1.username.length / 2)) + p2.username.slice(Math.floor(p2.username.length / 2));
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(cor).setTitle(`💘 Ship: ${nome}`).setDescription(`${p1} **+** ${p2}`).addFields({ name: '💘 Compatibilidade', value: `${bar} **${pct}%**`, inline: false }, { name: '💬 Veredicto', value: nivel, inline: false }).setFooter({ text: 'Sentinela • Ship' }).setTimestamp()] });
  },
});

// ─── /casar ──────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('casar').setDescription('💒 Peça alguém em casamento!').addUserOption(o => o.setName('pessoa').setDescription('Com quem?').setRequired(true)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('pessoa');
    if (alvo.id === interaction.user.id) return interaction.reply({ content: '💀 Você não pode se casar consigo mesmo!', ephemeral: true });
    if (alvo.bot) return interaction.reply({ content: '🤖 Bots não casam!', ephemeral: true });
    const userSelf = getUser(interaction.user.id, interaction.user.username);
    const userAlvo = getUser(alvo.id, alvo.username);
    if (userSelf.casado_com) return interaction.reply({ content: `💔 Você já é casado(a)! Use **/divorciar** primeiro.`, ephemeral: true });
    if (userAlvo.casado_com) return interaction.reply({ content: `💔 ${alvo.username} já está casado(a)!`, ephemeral: true });
    if (!hasItem(interaction.user.id, 'Anel de Casamento')) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('💍 Você precisa de um Anel de Casamento!').setDescription('Compre na **/loja** por **2.000 ✨ Aura**.')], ephemeral: true });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('casar_aceitar').setLabel('💒 Aceitar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('casar_recusar').setLabel('💔 Recusar').setStyle(ButtonStyle.Danger));
    const msg = await interaction.reply({ content: `${alvo}`, embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle('💍 Pedido de Casamento!').setDescription(`${alvo}, **${interaction.user.username}** está te pedindo em casamento!\n\nVocê aceita? 💍`).setFooter({ text: 'Você tem 60s para responder.' }).setTimestamp()], components: [row], fetchReply: true });
    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, filter: i => i.user.id === alvo.id, time: 60000 });
    collector.on('collect', async i => {
      collector.stop();
      if (i.customId === 'casar_aceitar') {
        removeItem(interaction.user.id, 'Anel de Casamento');
        const data = new Date().toISOString();
        dbRun('UPDATE usuarios SET casado_com = ?, data_casamento = ? WHERE id = ?', [alvo.id, data, interaction.user.id]);
        dbRun('UPDATE usuarios SET casado_com = ?, data_casamento = ? WHERE id = ?', [interaction.user.id, data, alvo.id]);
        await i.update({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle('🎊 Casamento realizado!').setDescription(`${interaction.user} 💒 ${alvo}\n\n🎉 Parabéns ao casal! Que sejam muito felizes!`).setFooter({ text: 'Sentinela • Casamento' }).setTimestamp()], components: [] });
      } else {
        await i.update({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('💔 Pedido recusado...').setDescription(`${alvo.username} recusou o pedido de ${interaction.user.username}.\n\n😔 Que triste...`).setFooter({ text: 'Sentinela • Casamento' })], components: [] });
      }
    });
    collector.on('end', (_, r) => { if (r === 'time') msg.edit({ components: [] }).catch(() => {}); });
  },
});

// ─── /divorciar ──────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('divorciar').setDescription('💔 Termine seu casamento...'),
  async execute(interaction) {
    const user = getUser(interaction.user.id, interaction.user.username);
    if (!user.casado_com) return interaction.reply({ content: '😅 Você nem é casado(a)!', ephemeral: true });
    dbRun('UPDATE usuarios SET casado_com = NULL, data_casamento = NULL WHERE id = ?', [interaction.user.id]);
    dbRun('UPDATE usuarios SET casado_com = NULL, data_casamento = NULL WHERE id = ?', [user.casado_com]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#808080').setTitle('💔 Divórcio finalizado').setDescription(`${interaction.user.username} e <@${user.casado_com}> se divorciaram.\n\n😢 Que pena...`).setFooter({ text: 'Sentinela • Divórcio' }).setTimestamp()] });
  },
});

// ─── /duelo ──────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('duelo').setDescription('⚔️ Desafie alguém para um duelo de Aura!').addUserOption(o => o.setName('oponente').setDescription('Quem desafiar').setRequired(true)).addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(50)),
  async execute(interaction) {
    const oponente = interaction.options.getUser('oponente');
    const aposta = interaction.options.getInteger('aposta');
    if (oponente.id === interaction.user.id) return interaction.reply({ content: '🤦 Você não pode se desafiar!', ephemeral: true });
    if (oponente.bot) return interaction.reply({ content: '🤖 Bots não aceitam duelos!', ephemeral: true });
    const des = getUser(interaction.user.id, interaction.user.username);
    const riv = getUser(oponente.id, oponente.username);
    if (des.aura < aposta) return interaction.reply({ content: `❌ Você não tem **${aposta} ✨** para apostar!`, ephemeral: true });
    if (riv.aura < aposta) return interaction.reply({ content: `❌ ${oponente.username} não tem **${aposta} ✨** para apostar!`, ephemeral: true });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('duelo_aceitar').setLabel('⚔️ Aceitar Duelo').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('duelo_recusar').setLabel('🏳️ Recusar').setStyle(ButtonStyle.Secondary));
    const msg = await interaction.reply({ content: `${oponente}`, embeds: [new EmbedBuilder().setColor('#FF6B00').setTitle('⚔️ Desafio de Duelo!').setDescription(`${oponente}, **${interaction.user.username}** te desafia!\n\n💰 Aposta: **${aposta.toLocaleString('pt-BR')} ✨ Aura**`).setFooter({ text: 'Sentinela • Duelo • 60s' })], components: [row], fetchReply: true });
    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, filter: i => i.user.id === oponente.id, time: 60000 });
    collector.on('collect', async i => {
      collector.stop();
      if (i.customId === 'duelo_recusar') return i.update({ embeds: [new EmbedBuilder().setColor('#808080').setTitle('🏳️ Duelo recusado').setDescription(`${oponente.username} não aceitou.`)], components: [] });
      await i.update({ components: [], embeds: [new EmbedBuilder().setColor('#FF6B00').setTitle('⚔️ Duelo em andamento...').setDescription('Rolando os dados...')] });
      const rD = Math.floor(Math.random() * 100) + 1, rO = Math.floor(Math.random() * 100) + 1;
      const [venc, perd] = rD >= rO ? [interaction.user, oponente] : [oponente, interaction.user];
      removeAura(perd.id, aposta); addAura(venc.id, aposta);
      dbRun('UPDATE usuarios SET wins = wins + 1 WHERE id = ?', [venc.id]);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('⚔️ Resultado do Duelo!').addFields({ name: `🎯 ${interaction.user.username}`, value: `Dado: **${rD}**`, inline: true }, { name: `🎯 ${oponente.username}`, value: `Dado: **${rO}**`, inline: true }, { name: '🏆 Vencedor', value: `${venc} ganhou **${aposta.toLocaleString('pt-BR')} ✨ Aura**!`, inline: false }).setFooter({ text: 'Sentinela • Duelo' }).setTimestamp()] });
    });
    collector.on('end', (_, r) => { if (r === 'time') msg.edit({ components: [] }).catch(() => {}); });
  },
});

// ─── /giveaway ───────────────────────────────────────────────
function parseDuracao(str) {
  const m = str.match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  return parseInt(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}
commands.push({
  data: new SlashCommandBuilder().setName('giveaway').setDescription('🎁 Crie um giveaway!').addStringOption(o => o.setName('premio').setDescription('O que vai ser sorteado?').setRequired(true)).addStringOption(o => o.setName('duracao').setDescription('Duração: ex: 10m, 1h, 2d').setRequired(true)).addIntegerOption(o => o.setName('vencedores').setDescription('Quantos vencedores?').setRequired(false).setMinValue(1).setMaxValue(10)).addIntegerOption(o => o.setName('aura').setDescription('Aura de prêmio').setRequired(false).setMinValue(0)),
  async execute(interaction) {
    const premio = interaction.options.getString('premio');
    const duracaoStr = interaction.options.getString('duracao');
    const vencedores = interaction.options.getInteger('vencedores') || 1;
    const auraPremi = interaction.options.getInteger('aura') || 0;
    const duracao = parseDuracao(duracaoStr);
    if (!duracao) return interaction.reply({ content: '❌ Duração inválida! Use: `10m`, `1h`, `2d`...', ephemeral: true });
    const terminaEm = new Date(Date.now() + duracao);
    const ts = Math.floor(terminaEm.getTime() / 1000);
    const descBase = (total) => `**Prêmio:** ${premio}${auraPremi > 0 ? `\n**Aura:** ✨ ${auraPremi.toLocaleString('pt-BR')}` : ''}\n\nClique em 🎉 para participar!\n\n⏰ Termina: <t:${ts}:R>\n🏆 Vencedores: **${vencedores}**\n👥 Participantes: **${total}**`;
    const embed = new EmbedBuilder().setColor('#FFD700').setTitle('🎁 GIVEAWAY!').setDescription(descBase(0)).setFooter({ text: `Criado por ${interaction.user.username} • Sentinela` }).setTimestamp(terminaEm);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('giveaway_entrar').setLabel('🎉 Participar').setStyle(ButtonStyle.Primary));
    await interaction.reply({ content: '✅ Giveaway criado!', ephemeral: true });
    const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
    dbRun(`INSERT INTO giveaways (message_id, channel_id, guild_id, premio, aura, host_id, vencedores, termina_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [msg.id, interaction.channel.id, interaction.guild.id, premio, auraPremi, interaction.user.id, vencedores, terminaEm.toISOString()]);
    const collector = msg.createMessageComponentCollector({ time: duracao });
    collector.on('collect', async i => {
      const gaw = dbGet('SELECT * FROM giveaways WHERE message_id = ?', [msg.id]);
      if (!gaw) return;
      if (dbGet('SELECT * FROM giveaway_participantes WHERE giveaway_id = ? AND user_id = ?', [gaw.id, i.user.id])) return i.reply({ content: '🎟️ Você já está participando!', ephemeral: true });
      dbRun('INSERT INTO giveaway_participantes (giveaway_id, user_id) VALUES (?, ?)', [gaw.id, i.user.id]);
      const total = dbGet('SELECT COUNT(*) as c FROM giveaway_participantes WHERE giveaway_id = ?', [gaw.id]).c;
      await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setDescription(descBase(total))] });
      await i.reply({ content: `✅ Você entrou! Boa sorte! 🍀`, ephemeral: true });
    });
    collector.on('end', async () => {
      const gaw = dbGet('SELECT * FROM giveaways WHERE message_id = ?', [msg.id]);
      if (!gaw) return;
      dbRun('UPDATE giveaways SET ativo = 0 WHERE id = ?', [gaw.id]);
      const parts = dbAll('SELECT user_id FROM giveaway_participantes WHERE giveaway_id = ?', [gaw.id]);
      const disRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gaw_end').setLabel('🎉 Encerrado').setStyle(ButtonStyle.Secondary).setDisabled(true));
      if (!parts.length) return msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setColor('#808080').setTitle('🎁 GIVEAWAY ENCERRADO').setDescription(`**Prêmio:** ${premio}\n\n❌ Ninguém participou...`)], components: [disRow] });
      const winners = parts.sort(() => Math.random() - 0.5).slice(0, Math.min(vencedores, parts.length));
      const wMention = winners.map(w => `<@${w.user_id}>`).join(', ');
      if (auraPremi > 0) for (const w of winners) { getUser(w.user_id); addAura(w.user_id, auraPremi); }
      await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setColor('#00C851').setTitle('🎊 GIVEAWAY ENCERRADO!').setDescription(`**Prêmio:** ${premio}${auraPremi > 0 ? `\n**Aura:** ✨ ${auraPremi.toLocaleString('pt-BR')}` : ''}\n\n🏆 **${winners.length > 1 ? 'Vencedores' : 'Vencedor'}:** ${wMention}\n👥 **Participantes:** ${parts.length}`)], components: [disRow] });
      await interaction.channel.send(`🎊 Parabéns ${wMention}! Você(s) ganhou(ganharam) **${premio}**!${auraPremi > 0 ? ` (+${auraPremi} ✨ Aura)` : ''}`);
    });
  },
});

// ─── /presentear ─────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('presentear').setDescription('🎁 Presenteie alguém com um item').addUserOption(o => o.setName('usuario').setDescription('Para quem?').setRequired(true)).addStringOption(o => o.setName('item').setDescription('Nome do item').setRequired(true)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const item = interaction.options.getString('item');
    if (alvo.id === interaction.user.id) return interaction.reply({ content: '🤦 Você não pode se dar presente!', ephemeral: true });
    if (alvo.bot) return interaction.reply({ content: '🤖 Bots não aceitam presentes.', ephemeral: true });
    if (!hasItem(interaction.user.id, item)) return interaction.reply({ content: `❌ Você não tem **${item}** no inventário!`, ephemeral: true });
    getUser(alvo.id, alvo.username);
    removeItem(interaction.user.id, item);
    addItem(alvo.id, item);
    const s = dbGet('SELECT emoji FROM shop WHERE LOWER(nome) = LOWER(?)', [item]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle('🎁 Presente enviado!').setDescription(`${interaction.user} deu **${s?.emoji || '🎁'} ${item}** para ${alvo}!\n\nQue presente charmoso! 💕`).setFooter({ text: 'Sentinela • Presente' }).setTimestamp()] });
  },
});

// ─── AÇÕES COM GIFs ───────────────────────────────────────────
const acoes = [
  { nome: 'hug',       desc: '🤗 Dê um abraço em alguém',      emoji: '🤗', cor: '#FF9F1C', frase: (a, b) => `${a} deu um abraço quentinho em ${b}! 🤗` },
  { nome: 'kiss',      desc: '💋 Dê um beijo em alguém',        emoji: '💋', cor: '#FF69B4', frase: (a, b) => `${a} beijou ${b}! 💋` },
  { nome: 'slap',      desc: '👋 Dê um tapa em alguém',         emoji: '👋', cor: '#FF6B6B', frase: (a, b) => `${a} deu um tapa em ${b}! Ai! 👋` },
  { nome: 'pat',       desc: '🥺 Faça cafuné em alguém',        emoji: '🥺', cor: '#A0C4FF', frase: (a, b) => `${a} fez cafuné em ${b}! 🥺` },
  { nome: 'punch',     desc: '🤛 Dê um soco em alguém',         emoji: '🤛', cor: '#FF4500', frase: (a, b) => `${a} deu um soco em ${b}! 🤛` },
  { nome: 'bite',      desc: '😬 Morda alguém',                 emoji: '😬', cor: '#9B2226', frase: (a, b) => `${a} mordeu ${b}! Autch! 😬` },
  { nome: 'cuddle',    desc: '🥰 Aconchegue-se com alguém',     emoji: '🥰', cor: '#FFAFCC', frase: (a, b) => `${a} está aconchegado(a) com ${b}! 🥰` },
  { nome: 'poke',      desc: '👉 Cutuque alguém',               emoji: '👉', cor: '#BDE0FE', frase: (a, b) => `${a} cutucou ${b}! Ei! 👉` },
  { nome: 'highfive',  desc: '✋ Dê um high five pra alguém',   emoji: '✋', cor: '#FFD166', frase: (a, b) => `${a} deu um high five pra ${b}! ✋` },
  { nome: 'wave',      desc: '👋 Acene para alguém',            emoji: '👋', cor: '#06D6A0', frase: (a, b) => `${a} acenou para ${b}! 👋` },
  { nome: 'wink',      desc: '😉 Pisque o olho para alguém',    emoji: '😉', cor: '#FFC8DD', frase: (a, b) => `${a} deu uma piscadela para ${b}! 😉` },
];
const gifsFallback = { hug: 'https://media.giphy.com/media/od5H3PmEG5EVq/giphy.gif', kiss: 'https://media.giphy.com/media/zkppEMFvRX5HO/giphy.gif', slap: 'https://media.giphy.com/media/Zau0yrl17uhdK/giphy.gif', pat: 'https://media.giphy.com/media/5tmRHwTlHAA9WkX6Oj/giphy.gif', punch: 'https://media.giphy.com/media/yIPHGGDMNmGI8/giphy.gif', bite: 'https://media.giphy.com/media/JKBpMSMqHoMwOHHuuH/giphy.gif', cuddle: 'https://media.giphy.com/media/l2QDM9Jnim1YVILXa/giphy.gif', poke: 'https://media.giphy.com/media/5C0a8IItAWRebylgQD/giphy.gif', highfive: 'https://media.giphy.com/media/3oEjHV0z8S7WM4MwnK/giphy.gif', wave: 'https://media.giphy.com/media/ASd0Ukj0y3qMM/giphy.gif', wink: 'https://media.giphy.com/media/nIBpVQB3cwzXq/giphy.gif' };
for (const a of acoes) {
  commands.push({
    data: new SlashCommandBuilder().setName(a.nome).setDescription(a.desc).addUserOption(o => o.setName('usuario').setDescription('Quem vai receber a ação').setRequired(true)),
    async execute(interaction) {
      const alvo = interaction.options.getUser('usuario');
      await interaction.deferReply();
      let gifUrl = gifsFallback[a.nome];
      try { const res = await axios.get(`https://nekos.life/api/v2/img/${a.nome}`, { timeout: 3000 }); if (res.data?.url) gifUrl = res.data.url; } catch { }
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(a.cor).setDescription(a.frase(interaction.user, alvo)).setImage(gifUrl).setFooter({ text: 'Sentinela • Ações' }).setTimestamp()] });
    },
  });
}

// ─── /8ball ──────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('8ball').setDescription('🎱 Consulte a Bola Mágica!').addStringOption(o => o.setName('pergunta').setDescription('Sua pergunta').setRequired(true)),
  async execute(interaction) {
    const pergunta = interaction.options.getString('pergunta');
    const respostas = [
      { t: 'Com certeza! ✅', c: '#00C851' }, { t: 'É decidido! ✅', c: '#00C851' }, { t: 'Sem dúvida! ✅', c: '#00C851' },
      { t: 'Sim, definitivamente! ✅', c: '#00C851' }, { t: 'Muito provável! 🟡', c: '#FFD700' },
      { t: 'Sinais apontam que sim 🟡', c: '#FFD700' }, { t: 'Não sei, tente de novo 🟠', c: '#FFA500' },
      { t: 'Não conte com isso ❌', c: '#FF6B6B' }, { t: 'Minha resposta é não ❌', c: '#FF6B6B' },
      { t: 'Muito duvidoso ❌', c: '#FF6B6B' },
    ];
    const r = respostas[Math.floor(Math.random() * respostas.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(r.c).setTitle('🎱 Bola Mágica').addFields({ name: '❓ Pergunta', value: pergunta }, { name: '🎱 Resposta', value: r.t }).setFooter({ text: 'Sentinela • 8Ball' })] });
  },
});

// ─── /coinflip ───────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('coinflip').setDescription('🪙 Cara ou Coroa?'),
  async execute(interaction) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🪙 Cara ou Coroa?').setDescription(`A moeda girou e... **${Math.random() < 0.5 ? 'Cara 👤' : 'Coroa 👑'}**!`).setFooter({ text: 'Sentinela • Coinflip' })] });
  },
});

// ─── /dado ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('dado').setDescription('🎲 Role um dado!').addIntegerOption(o => o.setName('lados').setDescription('Número de lados (padrão: 6)').setRequired(false).setMinValue(2).setMaxValue(1000)),
  async execute(interaction) {
    const lados = interaction.options.getInteger('lados') || 6;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🎲 Dado Rolado!').setDescription(`D${lados} → **${Math.floor(Math.random() * lados) + 1}**`).setFooter({ text: `Sentinela • Dado de ${lados} lados` })] });
  },
});

// ─── /rps ────────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('rps').setDescription('✊ Pedra, Papel ou Tesoura!').addStringOption(o => o.setName('escolha').setDescription('Sua escolha').setRequired(true).addChoices({ name: '✊ Pedra', value: 'pedra' }, { name: '🖐️ Papel', value: 'papel' }, { name: '✌️ Tesoura', value: 'tesoura' })),
  async execute(interaction) {
    const emojis = { pedra: '✊', papel: '🖐️', tesoura: '✌️' };
    const jogadas = ['pedra', 'papel', 'tesoura'];
    const j = interaction.options.getString('escolha');
    const b = jogadas[Math.floor(Math.random() * 3)];
    let res, cor;
    if (j === b) { res = '🤝 Empate!'; cor = '#FFD700'; }
    else if ((j === 'pedra' && b === 'tesoura') || (j === 'papel' && b === 'pedra') || (j === 'tesoura' && b === 'papel')) { res = '🎉 Você venceu!'; cor = '#00C851'; }
    else { res = '😢 Você perdeu!'; cor = '#FF6B6B'; }
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(cor).setTitle('✊ Pedra, Papel ou Tesoura!').addFields({ name: '👤 Você', value: `${emojis[j]} ${j}`, inline: true }, { name: '🤖 Sentinela', value: `${emojis[b]} ${b}`, inline: true }, { name: '🏆 Resultado', value: res, inline: false }).setFooter({ text: 'Sentinela • RPS' })] });
  },
});

// ─── /vod ────────────────────────────────────────────────────
const verdades = ['Qual foi a coisa mais estranha que você já fez?', 'Qual é o seu maior medo?', 'Você já mentiu para um amigo próximo?', 'Qual é o seu guilty pleasure secreto?', 'Você já ficou com alguém que não devia?', 'Qual foi sua maior vergonha online?', 'Você já teve um crush em alguém do servidor?', 'Você já chorou com um filme/série?'];
const desafios = ['Mande uma mensagem constrangedora para alguém aleatório!', 'Imite o último meme que você enviou no chat.', 'Escreva um poema de 4 linhas sobre o próximo membro a falar.', 'Fale em rima pelas próximas 3 mensagens.', 'Imite um pokémon por 1 minuto.', 'Mude seu nick para algo ridículo por 10 minutos.', 'Diga um segredo de jogador que você nunca contou.'];
commands.push({
  data: new SlashCommandBuilder().setName('vod').setDescription('🎭 Verdade ou Desafio!').addStringOption(o => o.setName('tipo').setDescription('Escolha').setRequired(false).addChoices({ name: '🤔 Verdade', value: 'verdade' }, { name: '💪 Desafio', value: 'desafio' })),
  async execute(interaction) {
    const tipo = interaction.options.getString('tipo') || (Math.random() < 0.5 ? 'verdade' : 'desafio');
    const lista = tipo === 'verdade' ? verdades : desafios;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(tipo === 'verdade' ? '#4ECDC4' : '#FF6B6B').setTitle(`${tipo === 'verdade' ? '🤔 Verdade' : '💪 Desafio'}!`).setDescription(lista[Math.floor(Math.random() * lista.length)]).setFooter({ text: `Sentinela • VoD • ${interaction.user.username}` }).setTimestamp()] });
  },
});

// ─── /escolher ───────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('escolher').setDescription('🤔 Deixa o Sentinela escolher por você!').addStringOption(o => o.setName('opcoes').setDescription('Opções separadas por vírgula').setRequired(true)),
  async execute(interaction) {
    const opcoes = interaction.options.getString('opcoes').split(',').map(o => o.trim()).filter(Boolean);
    if (opcoes.length < 2) return interaction.reply({ content: '❌ Coloque pelo menos 2 opções!', ephemeral: true });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🤔 A decisão foi tomada!').setDescription(`**${opcoes[Math.floor(Math.random() * opcoes.length)]}** 🎯`).addFields({ name: 'Opções', value: opcoes.join(', ') }).setFooter({ text: 'Sentinela • Escolher' })] });
  },
});

// ─── /pp ─────────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('pp').setDescription('📏 Medidor de... habilidades 😏').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const t = Number(BigInt(alvo.id) % 21n);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle('📏 Medidor de Habilidades').setDescription(`**${alvo.username}** tem...\n\n8${'█'.repeat(t)}${'░'.repeat(20 - t)}D\n\n**${t} cm** de talento!`).setFooter({ text: 'Sentinela • Totalmente científico 😏' })] });
  },
});

// ─── /gay ────────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('gay').setDescription('🏳️‍🌈 Medidor de gay-ness!').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const pct = Number(BigInt(alvo.id) % 101n);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle('🏳️‍🌈 Medidor de Gay-ness').setDescription(`${alvo} é **${pct}%** gay!\n\n${'🏳️‍🌈'.repeat(Math.floor(pct / 10))}${'⬛'.repeat(10 - Math.floor(pct / 10))}`).setFooter({ text: 'Sentinela • Por diversão! 🌈' })] });
  },
});

// ─── /impostora ──────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('impostora').setDescription('🔴 Quem é o/a impostor(a)?').addUserOption(o => o.setName('usuario').setDescription('Suspeito(a)').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const imp = Math.random() < 0.5;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(imp ? '#FF0000' : '#00C851').setTitle('🔴 Among Us').setDescription(imp ? `${alvo} **É O/A IMPOSTOR(A)!** 🔴\n\n*sus sus sus sus*` : `${alvo} **é inocente!** ✅\n\n*Parece confiável... ou será que não?*`).setFooter({ text: 'Sentinela • Ejete o impostor!' })] });
  },
});

// ─── /meme ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('meme').setDescription('😂 Meme aleatório do Reddit!'),
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const subs = ['memes', 'dankmemes', 'ProgrammerHumor'];
      const res = await axios.get(`https://meme-api.com/gimme/${subs[Math.floor(Math.random() * subs.length)]}`, { timeout: 5000 });
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF6B35').setTitle(res.data.title.slice(0, 256)).setImage(res.data.url).addFields({ name: '👍', value: `${res.data.ups}`, inline: true }, { name: '📌 r/', value: res.data.subreddit, inline: true }).setFooter({ text: 'Sentinela • Memes' }).setTimestamp()] });
    } catch { await interaction.editReply('❌ Não consegui buscar um meme agora. Tenta de novo!'); }
  },
});

// ─── /fato ───────────────────────────────────────────────────
const fatos = ['Um caracol pode dormir por até 3 anos seguidos.', 'As abelhas podem reconhecer rostos humanos.', 'Os polvos têm 3 corações e sangue azul.', 'Formigas nunca dormem.', 'Os humanos compartilham 60% do DNA com bananas.', 'Uma nuvem pode pesar mais de 500.000 kg.', 'Os tubarões são mais velhos que as árvores.', 'Cleopatra viveu mais perto da invenção do iPhone do que das pirâmides.', 'O mel nunca estraga. Mel com 3.000 anos ainda pode ser comido.'];
commands.push({
  data: new SlashCommandBuilder().setName('fato').setDescription('🧠 Fato aleatório curioso!'),
  async execute(interaction) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4ECDC4').setTitle('🧠 Fato Aleatório').setDescription(fatos[Math.floor(Math.random() * fatos.length)]).setFooter({ text: 'Sentinela • Fatos' }).setTimestamp()] });
  },
});

// ─── /conselho ───────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('conselho').setDescription('💡 Receba um conselho aleatório'),
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const res = await axios.get('https://api.adviceslip.com/advice', { timeout: 3000 });
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💡 Conselho do Dia').setDescription(`*"${res.data.slip.advice}"*`).setFooter({ text: 'Sentinela • Conselho' }).setTimestamp()] });
    } catch {
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💡 Conselho do Dia').setDescription('*"Beba água, durma bem e seja gentil com as pessoas."*').setFooter({ text: 'Sentinela • Conselho' })] });
    }
  },
});

// ─── /ping ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('ping').setDescription('🏓 Latência do bot'),
  async execute(interaction) {
    const sent = await interaction.reply({ content: '🏓 Calculando...', fetchReply: true });
    const lat = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply({ content: null, embeds: [new EmbedBuilder().setColor(lat < 100 ? '#00C851' : lat < 200 ? '#FFD700' : '#FF6B6B').setTitle('🏓 Pong!').addFields({ name: '⚡ Latência', value: `**${lat}ms**`, inline: true }, { name: '💓 Heartbeat', value: `**${interaction.client.ws.ping}ms**`, inline: true }).setFooter({ text: 'Sentinela • Ping' })] });
  },
});

// ─── /avatar ─────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('avatar').setDescription('🖼️ Veja o avatar de alguém').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const url = alvo.displayAvatarURL({ size: 1024, dynamic: true });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`🖼️ Avatar de ${alvo.username}`).setImage(url).addFields({ name: '🔗 Link', value: `[Clique aqui](${url})` }).setFooter({ text: 'Sentinela • Avatar' })] });
  },
});

// ─── /serverinfo ─────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('🏰 Informações do servidor'),
  async execute(interaction) {
    const g = interaction.guild;
    await g.fetch();
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`🏰 ${g.name}`).setThumbnail(g.iconURL({ size: 256 })).addFields({ name: '👑 Dono', value: `<@${g.ownerId}>`, inline: true }, { name: '👥 Membros', value: `${g.memberCount}`, inline: true }, { name: '📅 Criado em', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true }, { name: '💬 Canais', value: `${g.channels.cache.size}`, inline: true }, { name: '🎭 Cargos', value: `${g.roles.cache.size}`, inline: true }, { name: '😀 Emojis', value: `${g.emojis.cache.size}`, inline: true }, { name: '🆔 ID', value: g.id, inline: false }).setFooter({ text: 'Sentinela • Server Info' }).setTimestamp()] });
  },
});

// ─── /userinfo ───────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('userinfo').setDescription('👤 Informações de um usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getMember('usuario') || interaction.member;
    const user = alvo.user;
    const cargos = alvo.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position).first(5).map(r => `<@&${r.id}>`).join(', ') || 'Nenhum';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(alvo.displayHexColor || '#7B2FBE').setTitle(`👤 ${user.username}`).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields({ name: '🏷️ Tag', value: user.tag, inline: true }, { name: '🆔 ID', value: user.id, inline: true }, { name: '🤖 Bot?', value: user.bot ? 'Sim' : 'Não', inline: true }, { name: '📅 Conta criada', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`, inline: true }, { name: '📥 Entrou no servidor', value: `<t:${Math.floor(alvo.joinedTimestamp / 1000)}:D>`, inline: true }, { name: '🎭 Cargos', value: cargos, inline: false }).setFooter({ text: 'Sentinela • User Info' }).setTimestamp()] });
  },
});

// ─── /enquete ────────────────────────────────────────────────
const numEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
commands.push({
  data: new SlashCommandBuilder().setName('enquete').setDescription('📊 Crie uma enquete').addStringOption(o => o.setName('pergunta').setDescription('Qual a pergunta?').setRequired(true)).addStringOption(o => o.setName('opcoes').setDescription('Opções separadas por vírgula').setRequired(true)),
  async execute(interaction) {
    const pergunta = interaction.options.getString('pergunta');
    const opcoes = interaction.options.getString('opcoes').split(',').map(o => o.trim()).filter(Boolean);
    if (opcoes.length < 2) return interaction.reply({ content: '❌ Mínimo 2 opções!', ephemeral: true });
    if (opcoes.length > 10) return interaction.reply({ content: '❌ Máximo 10 opções!', ephemeral: true });
    const msg = await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`📊 ${pergunta}`).setDescription(opcoes.map((op, i) => `${numEmojis[i]} ${op}`).join('\n')).setFooter({ text: `Enquete por ${interaction.user.username} • Sentinela` }).setTimestamp()], fetchReply: true });
    for (let i = 0; i < opcoes.length; i++) await msg.react(numEmojis[i]);
  },
});

// ─── /sortear ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('sortear').setDescription('🎯 Sorteia um número aleatório').addIntegerOption(o => o.setName('min').setDescription('Mínimo').setRequired(false)).addIntegerOption(o => o.setName('max').setDescription('Máximo').setRequired(false)),
  async execute(interaction) {
    const min = interaction.options.getInteger('min') ?? 1;
    const max = interaction.options.getInteger('max') ?? 100;
    if (min >= max) return interaction.reply({ content: '❌ O mínimo deve ser menor que o máximo!', ephemeral: true });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🎯 Número Sorteado!').setDescription(`**${Math.floor(Math.random() * (max - min + 1)) + min}**\n\n*(entre ${min} e ${max})*`).setFooter({ text: 'Sentinela • Sorteio' })] });
  },
});

// ─── /say ────────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('say').setDescription('💬 Faz o Sentinela falar algo').addStringOption(o => o.setName('mensagem').setDescription('O que dizer').setRequired(true)),
  async execute(interaction) {
    await interaction.reply({ content: '✅', ephemeral: true });
    await interaction.channel.send(interaction.options.getString('mensagem'));
  },
});

// ─── /ajuda ──────────────────────────────────────────────────
const cats = {
  economia: { emoji: '💰', nome: 'Economia', desc: 'Aura e economia', cmds: ['`/daily` `/trabalho` `/crime` `/roubar` `/apostar` `/duelo`', '`/transferir` `/perfil` `/ranking` `/loja` `/comprar` `/inventario`'] },
  diversao: { emoji: '🎮', nome: 'Diversão', desc: 'Brincadeiras', cmds: ['`/ship` `/casar` `/divorciar` `/giveaway` `/vod` `/duelo`', '`/8ball` `/rps` `/coinflip` `/dado` `/pp` `/gay` `/impostora`', '`/escolher` `/meme` `/fato` `/conselho` `/presentear`'] },
  acoesCat: { emoji: '🥰', nome: 'Ações', desc: 'Ações com GIFs', cmds: ['`/hug` `/kiss` `/slap` `/pat` `/punch` `/bite`', '`/cuddle` `/poke` `/highfive` `/wave` `/wink`'] },
  util: { emoji: '🔧', nome: 'Utilidades', desc: 'Ferramentas', cmds: ['`/ping` `/avatar` `/userinfo` `/serverinfo`', '`/enquete` `/sortear` `/say` `/ajuda`'] },
};
commands.push({
  data: new SlashCommandBuilder().setName('ajuda').setDescription('📖 Lista todos os comandos'),
  async execute(interaction) {
    const mainEmbed = new EmbedBuilder().setColor('#7B2FBE').setTitle('📖 Sentinela — Central de Ajuda').setDescription('Selecione uma categoria abaixo!').addFields(Object.values(cats).map(c => ({ name: `${c.emoji} ${c.nome}`, value: c.desc, inline: true }))).setThumbnail(interaction.client.user.displayAvatarURL()).setFooter({ text: 'Sentinela • Ajuda' }).setTimestamp();
    const menu = new StringSelectMenuBuilder().setCustomId('ajuda_menu').setPlaceholder('📂 Selecione uma categoria...').addOptions(Object.entries(cats).map(([k, c]) => ({ label: c.nome, description: c.desc, value: k, emoji: c.emoji })));
    const msg = await interaction.reply({ embeds: [mainEmbed], components: [new ActionRowBuilder().addComponents(menu)], fetchReply: true });
    const col = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, filter: i => i.user.id === interaction.user.id, time: 120000 });
    col.on('collect', async i => {
      const c = cats[i.values[0]];
      await i.update({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`${c.emoji} ${c.nome}`).setDescription(c.cmds.join('\n')).setFooter({ text: 'Sentinela • Ajuda' }).setTimestamp()], components: [new ActionRowBuilder().addComponents(menu)] });
    });
    col.on('end', () => msg.edit({ components: [] }).catch(() => {}));
  },
});

// ─────────────────────────────────────────────────────────────
// REGISTRO DOS SLASH COMMANDS
// ─────────────────────────────────────────────────────────────
async function registrarComandos() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    console.log(`🔄 Registrando ${commands.length} comandos...`);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.data.toJSON()) });
    console.log('✅ Comandos registrados!');
  } catch (err) {
    console.error('❌ Erro ao registrar comandos:', err);
  }
}

// ─────────────────────────────────────────────────────────────
// CLIENT
// ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once('ready', async () => {
  console.log(`\n🟢 Sentinela online como ${client.user.tag}`);
  console.log(`📊 Servidores: ${client.guilds.cache.size}`);
  console.log(`🎮 Comandos carregados: ${commands.length}\n`);

  await registrarComandos();

  const atividades = [
    { name: '✨ Distribuindo Aura', type: ActivityType.Playing },
    { name: '💒 Casamentos épicos', type: ActivityType.Watching },
    { name: '🎁 /giveaway', type: ActivityType.Playing },
    { name: '🎯 /daily para ganhar Aura', type: ActivityType.Listening },
    { name: `🏰 ${client.guilds.cache.size} servidores`, type: ActivityType.Watching },
  ];
  let i = 0;
  client.user.setActivity(atividades[0].name, { type: atividades[0].type });
  setInterval(() => { i = (i + 1) % atividades.length; client.user.setActivity(atividades[i].name, { type: atividades[i].type }); }, 15000);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.find(c => c.data.name === interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction, client);
  } catch (err) {
    console.error(`❌ Erro em /${interaction.commandName}:`, err);
    const errEmbed = new EmbedBuilder().setColor('#FF0000').setTitle('❌ Ocorreu um erro!').setDescription('Algo deu errado. Tenta de novo!').setFooter({ text: 'Sentinela Bot' });
    if (interaction.replied || interaction.deferred) await interaction.followUp({ embeds: [errEmbed], ephemeral: true }).catch(() => {});
    else await interaction.reply({ embeds: [errEmbed], ephemeral: true }).catch(() => {});
  }
});


// Inicia o banco e depois o bot
initDb().then(() => {
  console.log('✅ Banco de dados carregado!');
  client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
  console.error('❌ Erro ao iniciar banco:', err);
  process.exit(1);
});
