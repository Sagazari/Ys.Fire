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


// ─── /apostar ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('apostar').setDescription('🎰 Aposte sua Aura em slots!').addIntegerOption(o => o.setName('quantidade').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const qt = interaction.options.getInteger('quantidade');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < qt) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Aura insuficiente!').setDescription(`Você tem apenas **${user.aura.toLocaleString('pt-BR')} ✨**`)] });
    const simbolos = ['🍒','🍋','🍊','🍇','⭐','💎','🎰','🍀'];
    const s = () => simbolos[Math.floor(Math.random() * simbolos.length)];
    const r = [s(), s(), s()];
    const linha = r.join(' | ');
    let mult = 0, msg = '';
    if (r[0] === r[1] && r[1] === r[2]) {
      mult = r[0] === '💎' ? 10 : r[0] === '🎰' ? 7 : r[0] === '⭐' ? 5 : 3;
      msg = mult === 10 ? '💎 JACKPOT DIAMANTE!!' : mult === 7 ? '🎰 JACKPOT!!' : '🎊 TRÊS IGUAIS!';
    } else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) { mult = 1.5; msg = '✨ Dois iguais!'; }
    else { msg = '😢 Sem sorte...'; }
    if (mult > 0) {
      const ganho = Math.floor(qt * mult);
      addAura(interaction.user.id, ganho - qt);
      addXP(interaction.user.id, 30);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle(`🎰 ${msg}`).setDescription(`${linha}

💰 Ganhou **+${(ganho - qt).toLocaleString('pt-BR')} ✨ Aura**! (x${mult})`).setFooter({ text: 'Sentinela • Slots' }).setTimestamp()] });
    } else {
      removeAura(interaction.user.id, qt);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle(`🎰 ${msg}`).setDescription(`${linha}

💸 Perdeu **-${qt.toLocaleString('pt-BR')} ✨ Aura**`).setFooter({ text: 'Sentinela • Slots' }).setTimestamp()] });
    }
  },
});

// ─── /blackjack ──────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('blackjack').setDescription('🃏 Jogue Blackjack contra o Sentinela!').addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const aposta = interaction.options.getInteger('aposta');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ content: `❌ Aura insuficiente! Você tem **${user.aura.toLocaleString('pt-BR')} ✨**`, ephemeral: true });
    const cartas = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
    const val = c => c === 'A' ? 11 : ['J','Q','K'].includes(c) ? 10 : parseInt(c);
    const carta = () => cartas[Math.floor(Math.random() * cartas.length)];
    const soma = (mao) => { let s = mao.reduce((a,c) => a + val(c), 0); for (const c of mao) if (s > 21 && c === 'A') s -= 10; return s; };
    let pJ = [carta(), carta()], pB = [carta(), carta()];
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bj_hit').setLabel('🃏 Pedir').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('bj_stand').setLabel('✋ Parar').setStyle(ButtonStyle.Secondary)
    );
    const emb = () => new EmbedBuilder().setColor('#1A1A2E').setTitle('🃏 Blackjack').addFields({ name: '🤖 Dealer', value: `${pB[0]} | ? (${val(pB[0])})`, inline: true }, { name: '👤 Você', value: `${pJ.join(' ')} (${soma(pJ)})`, inline: true }).setFooter({ text: `Aposta: ${aposta.toLocaleString('pt-BR')} ✨ • Sentinela` });
    const msg = await interaction.reply({ embeds: [emb()], components: [row], fetchReply: true });
    const col = msg.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 60000 });
    col.on('collect', async i => {
      if (i.customId === 'bj_hit') {
        pJ.push(carta());
        if (soma(pJ) > 21) {
          col.stop();
          removeAura(interaction.user.id, aposta);
          return i.update({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🃏 Estourou! Você perdeu!').setDescription(`Suas cartas: ${pJ.join(' ')} = **${soma(pJ)}**
💸 Perdeu **-${aposta.toLocaleString('pt-BR')} ✨**`)], components: [] });
        }
        return i.update({ embeds: [emb()], components: [row] });
      }
      if (i.customId === 'bj_stand') {
        col.stop();
        while (soma(pB) < 17) pB.push(carta());
        const sJ = soma(pJ), sB = soma(pB);
        let res, cor;
        if (sB > 21 || sJ > sB) { res = `🎉 Você venceu! **+${aposta.toLocaleString('pt-BR')} ✨**`; addAura(interaction.user.id, aposta); cor = '#00C851'; }
        else if (sJ === sB) { res = '🤝 Empate! Aposta devolvida.'; cor = '#FFD700'; }
        else { res = `😢 Dealer venceu. **-${aposta.toLocaleString('pt-BR')} ✨**`; removeAura(interaction.user.id, aposta); cor = '#FF6B6B'; }
        return i.update({ embeds: [new EmbedBuilder().setColor(cor).setTitle('🃏 Blackjack — Resultado').addFields({ name: '🤖 Dealer', value: `${pB.join(' ')} = **${sB}**`, inline: true }, { name: '👤 Você', value: `${pJ.join(' ')} = **${sJ}**`, inline: true }, { name: '🏆 Resultado', value: res })], components: [] });
      }
    });
    col.on('end', (_, r) => { if (r === 'time') msg.edit({ components: [] }).catch(() => {}); });
  },
});

// ─── /jokenpo ─────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('jokenpo').setDescription('🤜 Jokenpô com aposta de Aura!').addUserOption(o => o.setName('oponente').setDescription('Quem desafiar').setRequired(true)).addIntegerOption(o => o.setName('aposta').setDescription('Aposta em Aura').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const oponente = interaction.options.getUser('oponente');
    const aposta = interaction.options.getInteger('aposta');
    if (oponente.bot || oponente.id === interaction.user.id) return interaction.reply({ content: '❌ Alvo inválido!', ephemeral: true });
    const u1 = getUser(interaction.user.id, interaction.user.username);
    const u2 = getUser(oponente.id, oponente.username);
    if (u1.aura < aposta || u2.aura < aposta) return interaction.reply({ content: '❌ Um dos jogadores não tem Aura suficiente!', ephemeral: true });
    const opts = { pedra: '✊', papel: '🖐️', tesoura: '✌️' };
    const row = new ActionRowBuilder().addComponents(Object.entries(opts).map(([k,v]) => new ButtonBuilder().setCustomId(`jkp_${k}`).setLabel(`${v} ${k}`).setStyle(ButtonStyle.Primary)));
    const escolhas = {};
    const msg = await interaction.reply({ content: `${interaction.user} vs ${oponente} — apostando **${aposta} ✨**
Ambos escolham!`, components: [row], fetchReply: true });
    const col = msg.createMessageComponentCollector({ filter: i => [interaction.user.id, oponente.id].includes(i.user.id), time: 30000 });
    col.on('collect', async i => {
      const escolha = i.customId.replace('jkp_', '');
      escolhas[i.user.id] = escolha;
      await i.reply({ content: `✅ Você escolheu ${opts[escolha]}!`, ephemeral: true });
      if (Object.keys(escolhas).length === 2) col.stop('done');
    });
    col.on('end', async (_, r) => {
      if (r !== 'done') return msg.edit({ content: '⏰ Tempo esgotado!', components: [] });
      const c1 = escolhas[interaction.user.id], c2 = escolhas[oponente.id];
      let res;
      if (c1 === c2) res = '🤝 Empate!';
      else if ((c1==='pedra'&&c2==='tesoura')||(c1==='papel'&&c2==='pedra')||(c1==='tesoura'&&c2==='papel')) {
        res = `🏆 ${interaction.user.username} venceu!`; removeAura(oponente.id, aposta); addAura(interaction.user.id, aposta);
      } else {
        res = `🏆 ${oponente.username} venceu!`; removeAura(interaction.user.id, aposta); addAura(oponente.id, aposta);
      }
      await msg.edit({ content: `${interaction.user} ${opts[c1]} vs ${opts[c2]} ${oponente}

${res}
**Aposta:** ${aposta} ✨`, components: [] });
    });
  },
});

// ─── /flipacoin (apostar com cara/coroa) ─────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('flipacoin').setDescription('🪙 Cara ou Coroa com aposta!').addStringOption(o => o.setName('escolha').setDescription('Cara ou Coroa').setRequired(true).addChoices({ name: '👤 Cara', value: 'cara' }, { name: '👑 Coroa', value: 'coroa' })).addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const escolha = interaction.options.getString('escolha');
    const aposta = interaction.options.getInteger('aposta');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ content: '❌ Aura insuficiente!', ephemeral: true });
    const resultado = Math.random() < 0.5 ? 'cara' : 'coroa';
    if (escolha === resultado) {
      addAura(interaction.user.id, aposta);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('🪙 Você acertou!').setDescription(`A moeda deu **${resultado === 'cara' ? '👤 Cara' : '👑 Coroa'}**!
💰 Ganhou **+${aposta.toLocaleString('pt-BR')} ✨ Aura**!`)] });
    } else {
      removeAura(interaction.user.id, aposta);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🪙 Errou!').setDescription(`A moeda deu **${resultado === 'cara' ? '👤 Cara' : '👑 Coroa'}**!
💸 Perdeu **-${aposta.toLocaleString('pt-BR')} ✨ Aura**`)] });
    }
  },
});

// ─── /nivel ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('nivel').setDescription('⭐ Veja seu nível de XP').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const u = getUser(alvo.id, alvo.username);
    const xpNec = u.nivel * 500;
    const pct = Math.floor((u.xp / xpNec) * 20);
    const bar = '▓'.repeat(pct) + '░'.repeat(20 - pct);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`⭐ Nível de ${alvo.username}`).setDescription(`**Nível ${u.nivel}**

\`[${bar}]\` ${u.xp}/${xpNec} XP`).setThumbnail(alvo.displayAvatarURL()).setFooter({ text: 'Sentinela • XP' })] });
  },
});

// ─── /top_nivel ───────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('top_nivel').setDescription('⭐ Ranking de níveis do servidor'),
  async execute(interaction) {
    await interaction.deferReply();
    const top = dbAll('SELECT * FROM usuarios ORDER BY nivel DESC, xp DESC LIMIT 10', []);
    const linhas = await Promise.all(top.map(async (u, i) => {
      let nome; try { const m = await interaction.guild.members.fetch(u.id).catch(() => null); nome = m ? m.displayName : u.username; } catch { nome = u.username; }
      return `**${i + 1}.** **${nome}** — Nível **${u.nivel}** (${u.xp} XP)`;
    }));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('⭐ Ranking de Níveis').setDescription(linhas.join('\n')).setFooter({ text: 'Sentinela • Top Nível' }).setTimestamp()] });
  },
});

// ─── /missao ──────────────────────────────────────────────────
const missoes = [
  { txt: 'Use /trabalho 3 vezes hoje', recompensa: 500 },
  { txt: 'Dê um abraço em alguém (/hug)', recompensa: 300 },
  { txt: 'Participe de um giveaway', recompensa: 200 },
  { txt: 'Faça um duelo com alguém', recompensa: 600 },
  { txt: 'Compre um item na loja', recompensa: 400 },
  { txt: 'Transfira Aura para um amigo', recompensa: 350 },
  { txt: 'Aposte na roleta ou slots', recompensa: 450 },
  { txt: 'Veja o perfil de 3 pessoas', recompensa: 250 },
];
commands.push({
  data: new SlashCommandBuilder().setName('missao').setDescription('📋 Veja sua missão diária'),
  async execute(interaction) {
    const seed = interaction.user.id + new Date().toDateString();
    const idx = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % missoes.length;
    const m = missoes[idx];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('📋 Missão Diária!').setDescription(`**Missão:** ${m.txt}

**Recompensa:** +${m.recompensa} ✨ Aura ao completar manualmente com /resgatar_missao`).setFooter({ text: 'Sentinela • Missão Diária' }).setTimestamp()] });
  },
});

// ─── /resgatar_missao ─────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('resgatar_missao').setDescription('📋 Resgata a recompensa da missão diária'),
  async execute(interaction) {
    const hoje = new Date().toDateString();
    const key = `missao_${interaction.user.id}_${hoje}`;
    const resgatado = dbGet('SELECT * FROM inventario WHERE user_id = ? AND item = ?', [interaction.user.id, key]);
    if (resgatado) return interaction.reply({ content: '✅ Você já resgatou a missão de hoje!', ephemeral: true });
    const seed = interaction.user.id + hoje;
    const idx = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % missoes.length;
    const m = missoes[idx];
    addAura(interaction.user.id, m.recompensa);
    addItem(interaction.user.id, key);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('📋 Missão Resgatada!').setDescription(`Você resgatou **+${m.recompensa} ✨ Aura**!`).setFooter({ text: 'Sentinela • Missão' }).setTimestamp()] });
  },
});

// ─── /roleta ──────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('roleta').setDescription('🎡 Aposte na roleta russa de Aura!').addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(10)).addIntegerOption(o => o.setName('numero').setDescription('Número (0–36)').setRequired(true).setMinValue(0).setMaxValue(36)),
  async execute(interaction) {
    const aposta = interaction.options.getInteger('aposta');
    const numero = interaction.options.getInteger('numero');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ content: '❌ Aura insuficiente!', ephemeral: true });
    const resultado = Math.floor(Math.random() * 37);
    if (numero === resultado) {
      const ganho = aposta * 35;
      addAura(interaction.user.id, ganho);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🎡 JACKPOT NA ROLETA!!').setDescription(`A roleta parou no **${resultado}**!

🤑 Você ganhou **+${ganho.toLocaleString('pt-BR')} ✨ Aura**! (x35)`)] });
    } else {
      removeAura(interaction.user.id, aposta);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🎡 Roleta').setDescription(`A roleta parou no **${resultado}** (você escolheu ${numero}).
💸 Perdeu **-${aposta.toLocaleString('pt-BR')} ✨**`)] });
    }
  },
});

// ─── /aura_top_total ──────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('aura_top_total').setDescription('🏆 Ranking de Aura Total (histórico) do servidor'),
  async execute(interaction) {
    await interaction.deferReply();
    const top = dbAll('SELECT * FROM usuarios ORDER BY aura_total DESC LIMIT 10', []);
    const linhas = await Promise.all(top.map(async (u, i) => {
      let nome; try { const m = await interaction.guild.members.fetch(u.id).catch(() => null); nome = m ? m.displayName : u.username; } catch { nome = u.username; }
      return `**${i + 1}.** **${nome}** — ✨ ${u.aura_total.toLocaleString('pt-BR')} (total ganho)`;
    }));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Ranking Aura Total').setDescription(linhas.join('\n')).setFooter({ text: 'Sentinela • Top Total' }).setTimestamp()] });
  },
});

// ─── /aura_add (admin) ────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('aura_add').setDescription('🛡️ [Admin] Adiciona Aura a um usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).addIntegerOption(o => o.setName('quantidade').setDescription('Quantidade').setRequired(true).setMinValue(1)).setDefaultMemberPermissions(8),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const qt = interaction.options.getInteger('quantidade');
    getUser(alvo.id, alvo.username);
    addAura(alvo.id, qt);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('✅ Aura adicionada!').setDescription(`**+${qt.toLocaleString('pt-BR')} ✨** adicionado a ${alvo}!`).setFooter({ text: 'Sentinela • Admin' })] });
  },
});

// ─── /aura_remove (admin) ─────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('aura_remove').setDescription('🛡️ [Admin] Remove Aura de um usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).addIntegerOption(o => o.setName('quantidade').setDescription('Quantidade').setRequired(true).setMinValue(1)).setDefaultMemberPermissions(8),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const qt = interaction.options.getInteger('quantidade');
    getUser(alvo.id, alvo.username);
    removeAura(alvo.id, qt);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('✅ Aura removida!').setDescription(`**-${qt.toLocaleString('pt-BR')} ✨** removido de ${alvo}!`).setFooter({ text: 'Sentinela • Admin' })] });
  },
});

// ─── /aura_reset (admin) ──────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('aura_reset').setDescription('🛡️ [Admin] Zera a Aura de um usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)).setDefaultMemberPermissions(8),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    dbRun('UPDATE usuarios SET aura = 0 WHERE id = ?', [alvo.id]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#808080').setTitle('✅ Aura zerada!').setDescription(`A Aura de ${alvo} foi zerada.`).setFooter({ text: 'Sentinela • Admin' })] });
  },
});

// ─── /clima (fun fake) ────────────────────────────────────────
const climas = ['☀️ Ensolarado e quente, perfeito para um duelo!', '🌧️ Chuvoso — fique em casa e use /daily!', '⛈️ Tempestade de Aura se aproximando!', '❄️ Frio de congelar — a Aura rende mais hoje!', '🌈 Dia mágico! Bônus de sorte no ar.', '🌪️ Vendaval — cuidado com ladrões de Aura!', '🌫️ Neblina misteriosa no saloon...'];
commands.push({
  data: new SlashCommandBuilder().setName('clima').setDescription('🌤️ Veja o clima (fictício) do servidor'),
  async execute(interaction) {
    const c = climas[Math.floor(Math.random() * climas.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#87CEEB').setTitle('🌤️ Previsão do Tempo').setDescription(`**Hoje no servidor:**
${c}`).setFooter({ text: 'Sentinela • Clima • Fictício' }).setTimestamp()] });
  },
});

// ─── /piada ───────────────────────────────────────────────────
const piadas = [
  { p: 'Por que o programador foi ao médico?', r: 'Porque ele tinha um bug na memória! 🐛' },
  { p: 'O que o Discord disse para o WhatsApp?', r: 'Você me deu lag! 😅' },
  { p: 'Por que o bot nunca mente?', r: 'Porque ele sempre retorna true! ✅' },
  { p: 'Como o cowboy usa o computador?', r: 'No modo rascunho! (rascal) 🤠' },
  { p: 'Por que o gato não joga poker?', r: 'Porque ele sempre mostra as garras! 🐱' },
  { p: 'O que o hacker disse antes de dormir?', r: 'Boa noite... ou não. Depende do firewall! 🔥' },
];
commands.push({
  data: new SlashCommandBuilder().setName('piada').setDescription('😂 Receba uma piada aleatória'),
  async execute(interaction) {
    const p = piadas[Math.floor(Math.random() * piadas.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD166').setTitle('😂 Piada!').addFields({ name: '❓ Pergunta', value: p.p }, { name: '😄 Resposta', value: p.r }).setFooter({ text: 'Sentinela • Piada' })] });
  },
});

// ─── /curiosidade ─────────────────────────────────────────────
const curiosidades = [
  'Os polvos têm três corações e sangue azul! 🐙', 'A língua azul do boi é sinal de boa saúde! 🐂',
  'Mel nunca estraga — acharam mel de 3000 anos nas pirâmides! 🍯', 'O cérebro processa imagens em apenas 13ms! 🧠',
  'Formigas nunca dormem! 🐜', 'O som viaja 4x mais rápido na água do que no ar! 🌊',
  'Cada pessoa tem uma língua única como uma digital! 👅', 'Golfinhos dormem com metade do cérebro acordada! 🐬',
];
commands.push({
  data: new SlashCommandBuilder().setName('curiosidade').setDescription('🧠 Receba uma curiosidade aleatória'),
  async execute(interaction) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4ECDC4').setTitle('🧠 Curiosidade do Dia!').setDescription(curiosidades[Math.floor(Math.random() * curiosidades.length)]).setFooter({ text: 'Sentinela • Curiosidade' })] });
  },
});

// ─── /fortuna ─────────────────────────────────────────────────
const fortunas = [
  'Hoje é um bom dia para usar o /crime! 🦹', 'Sua Aura vai crescer muito em breve! ✨',
  'Cuidado com ladrões de Aura hoje! 🥷', 'Um presente especial está a caminho! 🎁',
  'Faça um duelo — os astros favorecem! ⚔️', 'Invista na loja hoje — sorte nos itens! 🛒',
  'Alguém está pensando em você... e na sua Aura! 💭', 'Dia perfeito para casar! 💍',
];
commands.push({
  data: new SlashCommandBuilder().setName('fortuna').setDescription('🔮 Consulte sua fortuna do dia!'),
  async execute(interaction) {
    const seed = interaction.user.id + new Date().toDateString();
    const idx = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % fortunas.length;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('🔮 Sua Fortuna Hoje!').setDescription(fortunas[idx]).setThumbnail('https://i.imgur.com/8vZl5.gif').setFooter({ text: `Sentinela • Fortuna de ${interaction.user.username}` }).setTimestamp()] });
  },
});

// ─── /aura_diaria_streak ──────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('streak').setDescription('🔥 Veja seu streak de /daily consecutivo'),
  async execute(interaction) {
    const u = getUser(interaction.user.id, interaction.user.username);
    const streak = dbGet('SELECT streak, last_streak FROM usuarios WHERE id = ?', [interaction.user.id]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B00').setTitle('🔥 Streak de Daily').setDescription(`Você tem **${u.nivel}** dias de nível acumulado.
Use **/daily** todo dia para manter o streak!`).setFooter({ text: 'Sentinela • Streak' })] });
  },
});

// ─── /comparar ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('comparar').setDescription('⚖️ Compare a Aura de duas pessoas').addUserOption(o => o.setName('usuario1').setDescription('Primeiro usuário').setRequired(true)).addUserOption(o => o.setName('usuario2').setDescription('Segundo usuário').setRequired(false)),
  async execute(interaction) {
    const u1 = interaction.options.getUser('usuario1');
    const u2 = interaction.options.getUser('usuario2') || interaction.user;
    const d1 = getUser(u1.id, u1.username);
    const d2 = getUser(u2.id, u2.username);
    const venc = d1.aura >= d2.aura ? u1 : u2;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('⚖️ Comparação de Aura').addFields({ name: u1.username, value: `✨ ${d1.aura.toLocaleString('pt-BR')}`, inline: true }, { name: '⚖️ vs', value: '​', inline: true }, { name: u2.username, value: `✨ ${d2.aura.toLocaleString('pt-BR')}`, inline: true }, { name: '🏆 Liderando', value: `**${venc.username}** está na frente!` }).setFooter({ text: 'Sentinela • Comparar' })] });
  },
});

// ─── /caçar ───────────────────────────────────────────────────
const animais = [
  { nome: 'Galinha',  emoji: '🐔', aura: [20,80],   xp: 10 },
  { nome: 'Coelho',   emoji: '🐰', aura: [50,150],  xp: 20 },
  { nome: 'Cervo',    emoji: '🦌', aura: [100,300], xp: 40 },
  { nome: 'Urso',     emoji: '🐻', aura: [200,500], xp: 60 },
  { nome: 'Dragão',   emoji: '🐉', aura: [500,1500],xp: 150 },
  { nome: 'Lenda',    emoji: '🌟', aura: [1000,3000],xp:300 },
];
commands.push({
  data: new SlashCommandBuilder().setName('cacar').setDescription('🏹 Vá caçar para ganhar Aura!'),
  async execute(interaction) {
    const u = getUser(interaction.user.id, interaction.user.username);
    const agora = new Date();
    const ultimo = u.last_trabalho ? new Date(u.last_trabalho) : null;
    const CD = 2 * 3600000;
    if (ultimo && agora - ultimo < CD) {
      const rest = new Date(ultimo.getTime() + CD - agora);
      const h = Math.floor(rest / 3600000), m = Math.floor((rest % 3600000) / 60000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🏹 Ainda cansado!').setDescription(`Descanse mais **${h}h ${m}m** antes de caçar.`)] });
    }
    const falhou = Math.random() < 0.2;
    if (falhou) {
      dbRun('UPDATE usuarios SET last_trabalho = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🏹 Caça fracassada!').setDescription('Você voltou de mãos vazias... O animal escapou!').setFooter({ text: 'Sentinela • Caça' })] });
    }
    const pesos = [40, 25, 15, 10, 7, 3];
    let rng = Math.random() * 100, acc = 0, animal = animais[0];
    for (let i = 0; i < animais.length; i++) { acc += pesos[i]; if (rng <= acc) { animal = animais[i]; break; } }
    const ganho = Math.floor(Math.random() * (animal.aura[1] - animal.aura[0])) + animal.aura[0];
    addAura(interaction.user.id, ganho);
    addXP(interaction.user.id, animal.xp);
    dbRun('UPDATE usuarios SET last_trabalho = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#8B4513').setTitle(`🏹 Você caçou um ${animal.nome}! ${animal.emoji}`).setDescription(`**+${ganho.toLocaleString('pt-BR')} ✨ Aura** e **+${animal.xp} XP**!`).setFooter({ text: 'Sentinela • Caça • CD: 2h' }).setTimestamp()] });
  },
});

// ─── /pescar ──────────────────────────────────────────────────
const peixes = [
  { nome: 'Peixinho',  emoji: '🐟', aura: [10,50],   xp: 5  },
  { nome: 'Salmão',    emoji: '🐠', aura: [30,100],  xp: 15 },
  { nome: 'Tubarão',   emoji: '🦈', aura: [100,400], xp: 50 },
  { nome: 'Polvo Raro',emoji: '🐙', aura: [300,800], xp: 100},
  { nome: 'Lixo',      emoji: '🗑️', aura: [0,0],     xp: 0  },
];
commands.push({
  data: new SlashCommandBuilder().setName('pescar').setDescription('🎣 Vá pescar para ganhar Aura!'),
  async execute(interaction) {
    const u = getUser(interaction.user.id, interaction.user.username);
    const agora = new Date();
    const ultimo = u.last_crime ? new Date(u.last_crime) : null;
    const CD = 1800000; // 30min
    if (ultimo && agora - ultimo < CD) {
      const rest = new Date(ultimo.getTime() + CD - agora);
      const m = Math.floor(rest / 60000), s = Math.floor((rest % 60000) / 1000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#4682B4').setTitle('🎣 Aguarde!').setDescription(`Pesque novamente em **${m}m ${s}s**.`)] });
    }
    const pesos = [35, 30, 20, 10, 5];
    let rng = Math.random() * 100, acc = 0, peixe = peixes[0];
    for (let i = 0; i < peixes.length; i++) { acc += pesos[i]; if (rng <= acc) { peixe = peixes[i]; break; } }
    dbRun('UPDATE usuarios SET last_crime = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    if (peixe.nome === 'Lixo') return interaction.reply({ embeds: [new EmbedBuilder().setColor('#808080').setTitle('🎣 Pescou lixo!').setDescription('Você pescou um **🗑️ Lixo**. Pelo menos ajudou o meio ambiente!').setFooter({ text: 'Sentinela • Pesca' })] });
    const ganho = Math.floor(Math.random() * (peixe.aura[1] - peixe.aura[0])) + peixe.aura[0];
    addAura(interaction.user.id, ganho);
    addXP(interaction.user.id, peixe.xp);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4682B4').setTitle(`🎣 Pescou um ${peixe.nome}! ${peixe.emoji}`).setDescription(`**+${ganho.toLocaleString('pt-BR')} ✨ Aura** e **+${peixe.xp} XP**!`).setFooter({ text: 'Sentinela • Pesca • CD: 30min' }).setTimestamp()] });
  },
});

// ─── /minerar ─────────────────────────────────────────────────
const minerios = [
  { nome: 'Carvão',    emoji: '⚫', aura: [5,30],    xp: 5  },
  { nome: 'Ferro',     emoji: '⚙️', aura: [20,80],   xp: 15 },
  { nome: 'Ouro',      emoji: '🥇', aura: [80,250],  xp: 40 },
  { nome: 'Diamante',  emoji: '💎', aura: [200,600], xp: 100},
  { nome: 'Aura Pura', emoji: '✨', aura: [500,1200],xp: 200},
];
commands.push({
  data: new SlashCommandBuilder().setName('minerar').setDescription('⛏️ Mine recursos para ganhar Aura!'),
  async execute(interaction) {
    const u = getUser(interaction.user.id, interaction.user.username);
    const agora = new Date();
    const ultimo = u.last_roubo ? new Date(u.last_roubo) : null;
    const CD = 3600000; // 1h
    if (ultimo && agora - ultimo < CD) {
      const rest = new Date(ultimo.getTime() + CD - agora);
      const m = Math.floor(rest / 60000), s = Math.floor((rest % 60000) / 1000);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#8B4513').setTitle('⛏️ Picareta quebrada!').setDescription(`Mine novamente em **${m}m ${s}s**.`)] });
    }
    const pesos = [40, 30, 15, 10, 5];
    let rng = Math.random() * 100, acc = 0, minerio = minerios[0];
    for (let i = 0; i < minerios.length; i++) { acc += pesos[i]; if (rng <= acc) { minerio = minerios[i]; break; } }
    const ganho = Math.floor(Math.random() * (minerio.aura[1] - minerio.aura[0])) + minerio.aura[0];
    addAura(interaction.user.id, ganho);
    addXP(interaction.user.id, minerio.xp);
    dbRun('UPDATE usuarios SET last_roubo = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#8B4513').setTitle(`⛏️ Você minerou ${minerio.nome}! ${minerio.emoji}`).setDescription(`**+${ganho.toLocaleString('pt-BR')} ✨ Aura** e **+${minerio.xp} XP**!`).setFooter({ text: 'Sentinela • Mineração • CD: 1h' }).setTimestamp()] });
  },
});

// ─── /lembrete ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('lembrete').setDescription('⏰ Configure um lembrete').addStringOption(o => o.setName('mensagem').setDescription('O que lembrar?').setRequired(true)).addIntegerOption(o => o.setName('minutos').setDescription('Em quantos minutos?').setRequired(true).setMinValue(1).setMaxValue(1440)),
  async execute(interaction) {
    const msg = interaction.options.getString('mensagem');
    const min = interaction.options.getInteger('minutos');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('⏰ Lembrete configurado!').setDescription(`Vou te lembrar em **${min} minutos**:
> ${msg}`).setFooter({ text: 'Sentinela • Lembrete' })] });
    setTimeout(async () => {
      try {
        await interaction.user.send({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('⏰ Lembrete!').setDescription(`Você pediu pra eu te lembrar:
> ${msg}`).setFooter({ text: 'Sentinela • Lembrete' }).setTimestamp()] });
      } catch { await interaction.channel.send(`${interaction.user} ⏰ **Lembrete:** ${msg}`).catch(() => {}); }
    }, min * 60000);
  },
});

// ─── /calcular ────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('calcular').setDescription('🧮 Faça um cálculo').addStringOption(o => o.setName('expressao').setDescription('Ex: 2+2, 10*5, 100/4').setRequired(true)),
  async execute(interaction) {
    const expr = interaction.options.getString('expressao').replace(/[^0-9+\-*/().% ]/g, '');
    try {
      const resultado = Function('"use strict"; return (' + expr + ')')();
      if (typeof resultado !== 'number' || !isFinite(resultado)) throw new Error();
      await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🧮 Calculadora').addFields({ name: '📝 Expressão', value: `\`${expr}\`` }, { name: '✅ Resultado', value: `**${resultado.toLocaleString('pt-BR')}**` }).setFooter({ text: 'Sentinela • Calculadora' })] });
    } catch { await interaction.reply({ content: '❌ Expressão inválida! Use apenas: `+`, `-`, `*`, `/`, `()`, `%`', ephemeral: true }); }
  },
});

// ─── /resumo (estatísticas do usuário) ────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('resumo').setDescription('📊 Resumo completo das suas estatísticas').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const u = getUser(alvo.id, alvo.username);
    const inv = getInventario(alvo.id);
    const pos = dbAll('SELECT id FROM usuarios ORDER BY aura DESC', []).findIndex(r => r.id === alvo.id) + 1;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`📊 Resumo de ${alvo.username}`).setThumbnail(alvo.displayAvatarURL()).addFields(
      { name: '✨ Aura Atual', value: u.aura.toLocaleString('pt-BR'), inline: true },
      { name: '🏆 Total Ganho', value: u.aura_total.toLocaleString('pt-BR'), inline: true },
      { name: '📊 Posição', value: `#${pos}`, inline: true },
      { name: '⭐ Nível', value: `${u.nivel}`, inline: true },
      { name: '⚔️ Vitórias', value: `${u.wins}`, inline: true },
      { name: '💀 Derrotas', value: `${u.mortes}`, inline: true },
      { name: '🎒 Itens', value: inv.length ? inv.map(i => `${i.item} x${i.quantidade}`).join(', ') : 'Vazio' },
      { name: '💍 Status', value: u.casado_com ? `Casado(a) com <@${u.casado_com}>` : 'Solteiro(a)', inline: true },
    ).setFooter({ text: 'Sentinela • Resumo' }).setTimestamp()] });
  },
});

// ─── /sorte ───────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('sorte').setDescription('🍀 Veja seu índice de sorte de hoje'),
  async execute(interaction) {
    const seed = interaction.user.id + new Date().toDateString();
    const sorte = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 101;
    const emoji = sorte >= 80 ? '🍀' : sorte >= 60 ? '😊' : sorte >= 40 ? '😐' : sorte >= 20 ? '😬' : '💀';
    const msg = sorte >= 80 ? 'Dia de sorte! Aposte tudo!' : sorte >= 60 ? 'Dia razoável, tente o crime!' : sorte >= 40 ? 'Mediano. Jogue pelo baixo.' : sorte >= 20 ? 'Cuidado hoje. Fique no /daily.' : 'Fique em casa. Sério.';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🍀 Índice de Sorte').setDescription(`${emoji} **${sorte}% de sorte hoje!**

${msg}`).setFooter({ text: `Sentinela • Sorte de ${interaction.user.username}` }).setTimestamp()] });
  },
});

// ─── /namorar ─────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('namorar').setDescription('💘 Peça alguém para namorar!').addUserOption(o => o.setName('usuario').setDescription('Quem você quer namorar?').setRequired(true)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    if (alvo.bot) return interaction.reply({ content: '🤖 Bots não namoram!', ephemeral: true });
    if (alvo.id === interaction.user.id) return interaction.reply({ content: '😅 Amor próprio é bom, mas não assim!', ephemeral: true });
    const aceite = Math.random() < 0.5;
    const msgs = {
      sim: [`${alvo.username} ficou corado(a) e aceitou! ❤️`, `${alvo.username} disse sim com um sorriso! 😊`, `${alvo.username} caiu de amores! 💕`],
      nao: [`${alvo.username} educadamente recusou... 💔`, `${alvo.username} disse que prefere amizade. 🤝`, `${alvo.username} nem respondeu as mensagens. 😭`],
    };
    const lista = aceite ? msgs.sim : msgs.nao;
    const resposta = lista[Math.floor(Math.random() * lista.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(aceite ? '#FF69B4' : '#808080').setTitle(aceite ? '💘 Romance!' : '💔 Não foi dessa vez...').setDescription(`${interaction.user} tentou namorar ${alvo}!

${resposta}`).setFooter({ text: 'Sentinela • Romance' }).setTimestamp()] });
  },
});

// ─── /trabalho_list ────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('trabalho_list').setDescription('💼 Lista todos os trabalhos disponíveis'),
  async execute(interaction) {
    const linhas = trabalhos.map(t => `${t.emoji} **${t.nome}** — ✨ ${t.min}–${t.max} Aura`).join('\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('💼 Trabalhos Disponíveis').setDescription(linhas).setFooter({ text: 'Sentinela • /trabalho' })] });
  },
});

// ─── /inventario_ver ──────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('inventario_ver').setDescription('🎒 Veja o inventário de outro usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(true)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const inv = getInventario(alvo.id);
    if (!inv.length) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#808080').setTitle(`🎒 Inventário de ${alvo.username}`).setDescription('Inventário vazio!')] });
    const linhas = inv.map(i => { const s = dbGet('SELECT emoji FROM shop WHERE LOWER(nome) = LOWER(?)', [i.item]); return `${s?.emoji || '📦'} **${i.item}** × ${i.quantidade}`; }).join('\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`🎒 Inventário de ${alvo.username}`).setDescription(linhas).setFooter({ text: 'Sentinela • Inventário' })] });
  },
});

// ─── /ping ─────────────────────────────────────────────────────
commands.push({
  data: new SlashCommandBuilder().setName('ping').setDescription('🏓 Latência do bot'),
  async execute(interaction) {
    const before = Date.now();
    await interaction.deferReply();
    const latency = Date.now() - before;
    const apiPing = Math.round(interaction.client.ws.ping);
    const status = latency < 200 ? '🟢' : latency < 500 ? '🟡' : '🔴';
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('🏓 Pong!').addFields({ name: '📡 Latência', value: `${status} **${latency}ms**`, inline: true }, { name: '💓 API Ping', value: `**${apiPing}ms**`, inline: true }).setFooter({ text: 'Sentinela • Ping' })] });
  },
});

// ─── /ajuda ──────────────────────────────────────────────────
const cats = {
  economia: { emoji: '💰', nome: 'Economia', desc: 'Aura, trabalho e comércio', cmds: [
    '`/daily` `/trabalho` `/crime` `/roubar` `/apostar` `/duelo`',
    '`/transferir` `/perfil` `/ranking` `/loja` `/comprar` `/inventario`',
    '`/blackjack` `/jokenpo` `/flipacoin` `/roleta` `/missao` `/resgatar_missao`',
    '`/aura_top_total` `/comparar` `/resumo` `/trabalho_list` `/inventario_ver`',
  ]},
  sobrevivencia: { emoji: '🏕️', nome: 'Sobrevivência', desc: 'Caçar, pescar e minerar', cmds: [
    '`/cacar` `/pescar` `/minerar`',
  ]},
  diversao: { emoji: '🎮', nome: 'Diversão', desc: 'Brincadeiras e social', cmds: [
    '`/ship` `/casar` `/divorciar` `/giveaway` `/vod` `/namorar`',
    '`/8ball` `/rps` `/coinflip` `/dado` `/pp` `/gay` `/impostora`',
    '`/piada` `/curiosidade` `/fortuna` `/sorte` `/clima` `/escolher`',
    '`/meme` `/fato` `/conselho` `/presentear`',
  ]},
  acoesCat: { emoji: '🥰', nome: 'Ações', desc: 'Ações com GIFs animados', cmds: [
    '`/hug` `/kiss` `/slap` `/pat` `/punch` `/bite`',
    '`/cuddle` `/poke` `/highfive` `/wave` `/wink`',
  ]},
  nivel: { emoji: '⭐', nome: 'Nível & XP', desc: 'Progresso e conquistas', cmds: [
    '`/nivel` `/top_nivel` `/streak`',
  ]},
  util: { emoji: '🔧', nome: 'Utilidades', desc: 'Ferramentas úteis', cmds: [
    '`/ping` `/avatar` `/userinfo` `/serverinfo`',
    '`/lembrete` `/calcular` `/enquete` `/sortear` `/say` `/ajuda`',
  ]},
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

  // ── Status rotativo ────────────────────────────────────────────────────────
  const atividades = [
    { name: '✨ Distribuindo Aura', type: ActivityType.Playing },
    { name: '💒 Casamentos épicos', type: ActivityType.Watching },
    { name: '🎁 /giveaway', type: ActivityType.Playing },
    { name: '🎯 /daily para ganhar Aura', type: ActivityType.Listening },
    { name: `🏰 ${client.guilds.cache.size} servidores`, type: ActivityType.Watching },
    { name: '🤠 Sentinela | o xerife da Aura', type: ActivityType.Watching },
  ];
  let i = 0;
  client.user.setActivity(atividades[0].name, { type: atividades[0].type });
  setInterval(() => { i = (i + 1) % atividades.length; client.user.setActivity(atividades[i].name, { type: atividades[i].type }); }, 15000);

  // ── Troca de avatar a cada 1h ──────────────────────────────────────────────
  // Coloque as URLs públicas dos avatares do Sentinela aqui:
  const avatares = [
    'https://i.imgur.com/AVATAR1.png', // substitua pelas URLs reais
    'https://i.imgur.com/AVATAR2.png',
    'https://i.imgur.com/AVATAR3.png',
  ];
  let avatarIdx = 0;
  const trocarAvatar = async () => {
    try {
      const res  = await axios.get(avatares[avatarIdx], { responseType: 'arraybuffer', timeout: 10000 });
      await client.user.setAvatar(Buffer.from(res.data));
      console.log(`[AVATAR] Trocado para avatar ${avatarIdx + 1}/${avatares.length}`);
      avatarIdx = (avatarIdx + 1) % avatares.length;
    } catch (e) {
      console.warn('[AVATAR] Falha ao trocar:', e.message);
    }
  };
  // Aguarda 30s antes da primeira troca (evita rate limit no startup)
  setTimeout(() => { trocarAvatar(); setInterval(trocarAvatar, 60 * 60 * 1000); }, 30000);
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


// ─────────────────────────────────────────────────────────────
// SERVIDOR HTTP — HEALTH CHECK (UptimeRobot)
// ─────────────────────────────────────────────────────────────
const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  // Responde 200 em qualquer rota GET — UptimeRobot às vezes bate na raiz "/"
  const status = client.isReady() ? 'online' : 'starting';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status, bot: client.user?.tag ?? null, uptime: process.uptime(), guilds: client.guilds.cache.size }));
}).listen(PORT, () => console.log(`🌐 Health server rodando na porta ${PORT}`));

// Inicia o banco e depois o bot
initDb().then(() => {
  console.log('✅ Banco de dados carregado!');
  client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
  console.error('❌ Erro ao iniciar banco:', err);
  process.exit(1);
});
