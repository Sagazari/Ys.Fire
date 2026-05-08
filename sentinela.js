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

  db.run(`\n    CREATE TABLE IF NOT EXISTS usuarios (\n      id TEXT PRIMARY KEY, username TEXT, aura INTEGER DEFAULT 0, aura_total INTEGER DEFAULT 0,\n      last_daily TEXT DEFAULT NULL, last_trabalho TEXT DEFAULT NULL, last_crime TEXT DEFAULT NULL,\n      last_roubo TEXT DEFAULT NULL, nivel INTEGER DEFAULT 1, xp INTEGER DEFAULT 0,\n      casado_com TEXT DEFAULT NULL, data_casamento TEXT DEFAULT NULL,\n      mortes INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))\n    );\n    CREATE TABLE IF NOT EXISTS inventario (\n      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item TEXT NOT NULL, quantidade INTEGER DEFAULT 1\n    );\n    CREATE TABLE IF NOT EXISTS giveaways (\n      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE, channel_id TEXT, guild_id TEXT,\n      premio TEXT, aura INTEGER DEFAULT 0, host_id TEXT, vencedores INTEGER DEFAULT 1,\n      termina_em TEXT, ativo INTEGER DEFAULT 1, criado_em TEXT DEFAULT (datetime('now'))\n    );\n    CREATE TABLE IF NOT EXISTS giveaway_participantes (\n      id INTEGER PRIMARY KEY AUTOINCREMENT, giveaway_id INTEGER, user_id TEXT, UNIQUE(giveaway_id, user_id)\n    );\n    CREATE TABLE IF NOT EXISTS shop (\n      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT UNIQUE, descricao TEXT, preco INTEGER, emoji TEXT, ativo INTEGER DEFAULT 1\n    );\n  `);

  for (const i of [
    { nome: 'Escudo de Moedas',    descricao: 'Protege contra roubo por 24h',        preco: 500,  emoji: '🛡️' },
    { nome: 'Amuleto da Sorte',  descricao: 'Dobra o ganho do Daily por 1 dia',     preco: 800,  emoji: '🍀' },
    { nome: 'Capa do Ladrão',    descricao: 'Aumenta chances no crime por 24h',     preco: 1200, emoji: '🥷' },
    { nome: 'Poção de XP',       descricao: 'Ganha 500 XP instantaneamente',        preco: 300,  emoji: '⚗️' },
    { nome: 'Anel de Casamento', descricao: 'Necessário para se casar',             preco: 2000, emoji: '💍' },
    { nome: 'Ticket de Sorte',   descricao: 'Aumenta suas chances no giveaway',     preco: 150,  emoji: '🎟️' },
    { nome: 'Elixir de Moedas',    descricao: 'Ganha 1000 💵 na hora',          preco: 900,  emoji: '✨' },
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
  data: new SlashCommandBuilder().setName('daily').setDescription('🌟 Colete suas Moedas diárias!'),
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💵 Moedas Coletada!').setDescription(`${interaction.user}, você coletou sua Moedas do dia!`).addFields({ name: '💵 Moedas Recebida', value: `**+${total.toLocaleString('pt-BR')}**${bonus > 0 ? ` (🎉 Bônus: +${bonus})` : ''}`, inline: true }, { name: '💰 Moedas Totais', value: `**${ua.aura.toLocaleString('pt-BR')}**`, inline: true }, { name: '⭐ XP', value: `**+100 XP**${levelUp ? ` → Nível **${novoNivel}**! 🎊` : ''}`, inline: true }).setThumbnail(interaction.user.displayAvatarURL()).setFooter({ text: temAmuleto ? '🍀 Amuleto da Sorte ativo!' : 'Sentinela • Daily' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('trabalho').setDescription('💼 Trabalhe para ganhar Moedas'),
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`${t.emoji} Trabalho: ${t.nome}`).setDescription(`${t.frase} **+${ganho.toLocaleString('pt-BR')} 💵 Moedas**!`).addFields({ name: '⭐ XP', value: '+50 XP', inline: true }).setFooter({ text: 'Sentinela • Trabalho • CD: 1h' }).setTimestamp()] });
  },
});

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
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`${crime.emoji} Crime bem-sucedido!`).setDescription(`Você **${crime.nome}** e ninguém te viu!\n\n💰 Ganhou **+${ganho.toLocaleString('pt-BR')} 💵 Moedas**!`).setFooter({ text: `Sentinela • Crime${temCapa ? ' • 🥷 Capa ativa' : ''}` }).setTimestamp()] });
    } else {
      const multa = Math.floor(Math.random() * 300) + 100;
      removeAura(interaction.user.id, multa);
      dbRun('UPDATE usuarios SET mortes = mortes + 1 WHERE id = ?', [interaction.user.id]);
      const falha = falhasCrime[Math.floor(Math.random() * falhasCrime.length)];
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('🚔 Você foi preso!').setDescription(`${falha}\n\nPagou **-${multa} 💵 Moedas** de fiança.`).setFooter({ text: 'Sentinela • Crime' }).setTimestamp()] });
    }
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('roubar').setDescription('🥷 Tente roubar a Moedas de alguém').addUserOption(o => o.setName('alvo').setDescription('Quem roubar').setRequired(true)),
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
    if (hasItem(alvo.id, 'Escudo de Moedas')) {
      dbRun('UPDATE usuarios SET last_roubo = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🛡️ Bloqueado!').setDescription(`${alvo.username} está protegido por um **Escudo de Moedas**!`)] });
    }
    dbRun('UPDATE usuarios SET last_roubo = ? WHERE id = ?', [agora.toISOString(), interaction.user.id]);
    if (Math.random() < 0.45) {
      const pct = Math.random() * 0.25 + 0.05;
      const roubado = Math.floor(vitima.aura * pct);
      removeAura(alvo.id, roubado);
      addAura(interaction.user.id, roubado);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('🥷 Roubo bem-sucedido!').setDescription(`Você roubou **${roubado.toLocaleString('pt-BR')} 💵 Moedas** de ${alvo}!`).setFooter({ text: 'Sentinela • Roubo' }).setTimestamp()] });
    } else {
      const multa = Math.floor(Math.random() * 200) + 100;
      removeAura(interaction.user.id, multa);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF0000').setTitle('🚨 Flagrado!').setDescription(`${alvo} te pegou! Pagou **-${multa} 💵 Moedas** de indenização.`).setFooter({ text: 'Sentinela • Roubo' }).setTimestamp()] });
    }
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('transferir').setDescription('💸 Transfira Moedas para outro usuário').addUserOption(o => o.setName('usuario').setDescription('Quem vai receber').setRequired(true)).addIntegerOption(o => o.setName('quantidade').setDescription('Quanto').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const qt = interaction.options.getInteger('quantidade');
    if (alvo.id === interaction.user.id) return interaction.reply({ content: '🤦 Não pode transferir para si mesmo!', ephemeral: true });
    if (alvo.bot) return interaction.reply({ content: '🤖 Bots não aceitam Aura.', ephemeral: true });
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < qt) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Moedas insuficientes!').setDescription(`Você tem apenas **${user.aura.toLocaleString('pt-BR')} ✨**.`)] });
    getUser(alvo.id, alvo.username);
    removeAura(interaction.user.id, qt);
    addAura(alvo.id, qt);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('💸 Transferência realizada!').setDescription(`**${interaction.user.username}** enviou **${qt.toLocaleString('pt-BR')} 💵 Moedas** para ${alvo}!`).setFooter({ text: 'Sentinela • Transferência' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('perfil').setDescription('👤 Veja seu perfil ou de outro usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const user = getUser(alvo.id, alvo.username);
    const xpNec = user.nivel * 500;
    const bar = '█'.repeat(Math.floor((user.xp / xpNec) * 10)) + '░'.repeat(10 - Math.floor((user.xp / xpNec) * 10));
    const medalha = user.nivel >= 50 ? '👑' : user.nivel >= 30 ? '💎' : user.nivel >= 20 ? '🥇' : user.nivel >= 10 ? '🥈' : '🥉';
    const casado = user.casado_com ? `💒 Casado(a) com <@${user.casado_com}>` : '💔 Solteiro(a)';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`${medalha} Perfil de ${alvo.username}`).setThumbnail(alvo.displayAvatarURL({ size: 256 })).addFields({ name: '💵 Moedas', value: `**${user.aura.toLocaleString('pt-BR')}**`, inline: true }, { name: '🏆 Moedas Totais', value: `**${user.aura_total.toLocaleString('pt-BR')}**`, inline: true }, { name: '⭐ Nível', value: `**${user.nivel}**`, inline: true }, { name: `📊 XP [${bar}]`, value: `${user.xp} / ${xpNec}`, inline: false }, { name: '💍 Status', value: casado, inline: false }).setFooter({ text: 'Sentinela • Perfil' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('ranking').setDescription('🌍 Top 10 Global de Moedas (todos os servidores)'),
  async execute(interaction) {
    await interaction.deferReply();
    const top = dbAll('SELECT * FROM usuarios ORDER BY aura DESC LIMIT 10', []);
    if (!top.length) return interaction.editReply('Nenhum usuário registrado ainda!');
    const medalhas = ['🥇', '🥈', '🥉'];
    const linhas = await Promise.all(top.map(async (u, i) => {
      let nome = u.username || 'Usuário';
      try { const f = await interaction.client.users.fetch(u.id).catch(() => null); if (f) nome = f.username; } catch {}
      return `${medalhas[i] || `**${i + 1}.**`} **${nome}** — 💵 ${Number(u.aura).toLocaleString('pt-BR')} Moedas`;
    }));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🌍 Ranking Global de Moedas').setDescription(linhas.join('\n')).setFooter({ text: 'Sentinela • Top Global • Todos os servidores' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('top').setDescription('🏆 Top 10 de Moedas deste servidor'),
  async execute(interaction) {
    await interaction.deferReply();
    const membros = await interaction.guild.members.fetch().catch(() => null);
    if (!membros) return interaction.editReply('Não consegui buscar os membros!');
    const ids = [...membros.keys()];
    const placeholders = ids.map(() => '?').join(',');
    const top = dbAll(`SELECT * FROM usuarios WHERE id IN (${placeholders}) ORDER BY aura DESC LIMIT 10`, ids);
    if (!top.length) return interaction.editReply('Nenhum usuário registrado neste servidor!');
    const medalhas = ['🥇', '🥈', '🥉'];
    const linhas = top.map((u, i) => {
      const m = membros.get(u.id);
      const nome = m ? m.displayName : u.username || 'Usuário';
      return `${medalhas[i] || `**${i + 1}.**`} **${nome}** — 💵 ${Number(u.aura).toLocaleString('pt-BR')} Moedas`;
    });
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`🏆 Top Moedas — ${interaction.guild.name}`).setDescription(linhas.join('\n')).setFooter({ text: 'Sentinela • Top Servidor' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('loja').setDescription('🛒 Veja os itens da loja'),
  async execute(interaction) {
    const itens = dbAll('SELECT * FROM shop WHERE ativo = 1', []);
    const user = getUser(interaction.user.id);
    const linhas = itens.map(i => `${i.emoji} **${i.nome}** — \`${i.preco.toLocaleString('pt-BR')} ✨\`\n> ${i.descricao}`).join('\n\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🛒 Loja da Aura').setDescription(linhas).addFields({ name: '💰 Suas Moedas', value: `**${user.aura.toLocaleString('pt-BR')}**`, inline: true }).setFooter({ text: 'Use /comprar <item> • Sentinela' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('comprar').setDescription('💳 Compre um item da loja').addStringOption(o => o.setName('item').setDescription('Nome do item').setRequired(true)),
  async execute(interaction) {
    const nome = interaction.options.getString('item');
    const item = dbGet('SELECT * FROM shop WHERE LOWER(nome) = LOWER(?) AND ativo = 1', [nome]);
    if (!item) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Item não encontrado!').setDescription('Use **/loja** para ver os itens.')], ephemeral: true });
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < item.preco) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Moedas insuficientes!').setDescription(`Você precisa de **${item.preco.toLocaleString('pt-BR')} ✨** mas tem **${user.aura.toLocaleString('pt-BR')} ✨**.`)], ephemeral: true });
    removeAura(interaction.user.id, item.preco);
    if (item.nome === 'Elixir de Moedas') addAura(interaction.user.id, 1000);
    else addItem(interaction.user.id, item.nome);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle(`${item.emoji} Compra realizada!`).setDescription(`Você comprou **${item.nome}** por **${item.preco.toLocaleString('pt-BR')} ✨**!`).setFooter({ text: item.nome === 'Elixir de Moedas' ? '✨ +1000 Aura adicionados!' : 'Item no inventário!' }).setTimestamp()] });
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('apostar').setDescription('🎰 Aposte sua Moedas em slots!').addIntegerOption(o => o.setName('quantidade').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const qt = interaction.options.getInteger('quantidade');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < qt) return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Moedas insuficientes!').setDescription(`Você tem apenas **${user.aura.toLocaleString('pt-BR')} ✨**`)] });
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
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle(`🎰 ${msg}`).setDescription(`${linha}\n\n💰 Ganhou **+${(ganho - qt).toLocaleString('pt-BR')} 💵 Moedas**! (x${mult})`).setFooter({ text: 'Sentinela • Slots' }).setTimestamp()] });
    } else {
      removeAura(interaction.user.id, qt);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle(`🎰 ${msg}`).setDescription(`${linha}\n\n💸 Perdeu **-${qt.toLocaleString('pt-BR')} 💵 Moedas**`).setFooter({ text: 'Sentinela • Slots' }).setTimestamp()] });
    }
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('ship').setDescription('💘 Calcula a compatibilidade entre dois usuários').addUserOption(o => o.setName('usuario1').setDescription('Primeiro usuário').setRequired(true)).addUserOption(o => o.setName('usuario2').setDescription('Segundo usuário').setRequired(true)),
  async execute(interaction) {
    const u1 = interaction.options.getUser('usuario1');
    const u2 = interaction.options.getUser('usuario2');
    const seed = [u1.id, u2.id].sort().join('');
    const pct = seed.split('').reduce((a,c) => a + c.charCodeAt(0), 0) % 101;
    const emoji = pct >= 90?'💍':pct>=70?'❤️':pct>=50?'😊':pct>=30?'😐':'💔';
    const msg = pct>=90?'Feitos um para o outro!':pct>=70?'Muita química!':pct>=50?'Tem potencial...':pct>=30?'Amizade colorida talvez?':'Nem como amigos...';
    const bar = '❤️'.repeat(Math.floor(pct/10)) + '🖤'.repeat(10-Math.floor(pct/10));
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle(`💘 Ship: ${u1.username} + ${u2.username}`).setDescription(`${bar}\n\n**${pct}% compatíveis!** ${emoji}\n${msg}`).setFooter({text:'Sentinela • Ship'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('casar').setDescription('💍 Peça alguém em casamento!').addUserOption(o => o.setName('usuario').setDescription('Com quem quer casar?').setRequired(true)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    if (alvo.bot) return interaction.reply({content:'🤖 Bots não casam!',ephemeral:true});
    if (alvo.id === interaction.user.id) return interaction.reply({content:'😅 Amor próprio, mas não assim!',ephemeral:true});
    const u1 = getUser(interaction.user.id, interaction.user.username);
    const u2 = getUser(alvo.id, alvo.username);
    if (u1.casado_com) return interaction.reply({content:`❌ Você já é casado(a) com <@${u1.casado_com}>! Divorcie-se primeiro.`,ephemeral:true});
    if (u2.casado_com) return interaction.reply({content:`❌ ${alvo.username} já é casado(a)!`,ephemeral:true});
    if (!hasItem(interaction.user.id,'Anel de Casamento')) return interaction.reply({content:'❌ Você precisa de um **💍 Anel de Casamento** da `/loja`!',ephemeral:true});
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('casar_sim').setLabel('💍 Aceitar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('casar_nao').setLabel('💔 Recusar').setStyle(ButtonStyle.Danger)
    );
    const msg = await interaction.reply({content:`${alvo}`, embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('💍 Pedido de Casamento!').setDescription(`${interaction.user} pediu ${alvo} em casamento!\n\n💍 Aceita?`).setFooter({text:'Sentinela • Casamento • 60s'})], components:[row], fetchReply:true});
    const col = msg.createMessageComponentCollector({filter:i=>i.user.id===alvo.id, time:60000});
    col.on('collect', async i => {
      col.stop();
      if (i.customId==='casar_nao') return i.update({embeds:[new EmbedBuilder().setColor('#808080').setTitle('💔 Pedido recusado').setDescription(`${alvo.username} disse não... 😢`)],components:[]});
      removeItem(interaction.user.id,'Anel de Casamento');
      const data = new Date().toISOString();
      dbRun('UPDATE usuarios SET casado_com = ?, data_casamento = ? WHERE id = ?',[alvo.id, data, interaction.user.id]);
      dbRun('UPDATE usuarios SET casado_com = ?, data_casamento = ? WHERE id = ?',[interaction.user.id, data, alvo.id]);
      await i.update({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('💒 Casamento Realizado!').setDescription(`${interaction.user} e ${alvo} agora são casados(as)! 💍\n\nParabéns ao casal! 🎊`).setTimestamp()],components:[]});
    });
    col.on('end',(_,r)=>{if(r==='time') msg.edit({components:[]}).catch(()=>{})});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('divorciar').setDescription('💔 Termine seu casamento...'),
  async execute(interaction) {
    const u = getUser(interaction.user.id, interaction.user.username);
    if (!u.casado_com) return interaction.reply({content:'😅 Você nem é casado(a)!',ephemeral:true});
    dbRun('UPDATE usuarios SET casado_com = NULL, data_casamento = NULL WHERE id = ?',[interaction.user.id]);
    dbRun('UPDATE usuarios SET casado_com = NULL, data_casamento = NULL WHERE id = ?',[u.casado_com]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#808080').setTitle('💔 Divórcio').setDescription(`${interaction.user.username} e <@${u.casado_com}> se divorciaram. 😢`).setFooter({text:'Sentinela • Divórcio'}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('duelo').setDescription('⚔️ Desafie alguém para um duelo de Moedas!').addUserOption(o => o.setName('oponente').setDescription('Quem desafiar').setRequired(true)).addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(50)),
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
    const msg = await interaction.reply({ content: `${oponente}`, embeds: [new EmbedBuilder().setColor('#FF6B00').setTitle('⚔️ Desafio de Duelo!').setDescription(`${oponente}, **${interaction.user.username}** te desafia!\n\n💰 Aposta: **${aposta.toLocaleString('pt-BR')} 💵 Moedas**`).setFooter({ text: 'Sentinela • Duelo • 60s' })], components: [row], fetchReply: true });
    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, filter: i => i.user.id === oponente.id, time: 60000 });
    collector.on('collect', async i => {
      collector.stop();
      if (i.customId === 'duelo_recusar') return i.update({ embeds: [new EmbedBuilder().setColor('#808080').setTitle('🏳️ Duelo recusado').setDescription(`${oponente.username} não aceitou.`)], components: [] });
      await i.update({ components: [], embeds: [new EmbedBuilder().setColor('#FF6B00').setTitle('⚔️ Duelo em andamento...').setDescription('Rolando os dados...')] });
      const rD = Math.floor(Math.random() * 100) + 1, rO = Math.floor(Math.random() * 100) + 1;
      const [venc, perd] = rD >= rO ? [interaction.user, oponente] : [oponente, interaction.user];
      removeAura(perd.id, aposta); addAura(venc.id, aposta);
      dbRun('UPDATE usuarios SET wins = wins + 1 WHERE id = ?', [venc.id]);
      await msg.edit({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('⚔️ Resultado do Duelo!').addFields({ name: `🎯 ${interaction.user.username}`, value: `Dado: **${rD}**`, inline: true }, { name: `🎯 ${oponente.username}`, value: `Dado: **${rO}**`, inline: true }, { name: '🏆 Vencedor', value: `${venc} ganhou **${aposta.toLocaleString('pt-BR')} 💵 Moedas**!`, inline: false }).setFooter({ text: 'Sentinela • Duelo' }).setTimestamp()] });
    });
    collector.on('end', (_, r) => { if (r === 'time') msg.edit({ components: [] }).catch(() => {}); });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('giveaway').setDescription('🎁 Crie um giveaway!').addStringOption(o => o.setName('premio').setDescription('O que vai ser sorteado?').setRequired(true)).addStringOption(o => o.setName('duracao').setDescription('Duração: ex: 10m, 1h, 2d').setRequired(true)).addIntegerOption(o => o.setName('vencedores').setDescription('Quantos vencedores?').setRequired(false).setMinValue(1).setMaxValue(10)).addIntegerOption(o => o.setName('aura').setDescription('Moedas de prêmio').setRequired(false).setMinValue(0)),
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
      await interaction.channel.send(`🎊 Parabéns ${wMention}! Você(s) ganhou(ganharam) **${premio}**!${auraPremi > 0 ? ` (+${auraPremi} 💵 Moedas)` : ''}`);
    });
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('coinflip').setDescription('🪙 Cara ou Coroa?'),
  async execute(interaction) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🪙 Cara ou Coroa?').setDescription(`A moeda girou e... **${Math.random() < 0.5 ? 'Cara 👤' : 'Coroa 👑'}**!`).setFooter({ text: 'Sentinela • Coinflip' })] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('dado').setDescription('🎲 Role um dado!').addIntegerOption(o => o.setName('lados').setDescription('Número de lados (padrão: 6)').setRequired(false).setMinValue(2).setMaxValue(1000)),
  async execute(interaction) {
    const lados = interaction.options.getInteger('lados') || 6;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle('🎲 Dado Rolado!').setDescription(`D${lados} → **${Math.floor(Math.random() * lados) + 1}**`).setFooter({ text: `Sentinela • Dado de ${lados} lados` })] });
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('vod').setDescription('🎭 Verdade ou Desafio!').addStringOption(o => o.setName('tipo').setDescription('Escolha').setRequired(false).addChoices({name:'🤔 Verdade',value:'verdade'},{name:'💪 Desafio',value:'desafio'})),
  async execute(interaction) {
    const tipo = interaction.options.getString('tipo') || (Math.random()<0.5?'verdade':'desafio');
    const lista = tipo==='verdade'?verdades:desafios;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(tipo==='verdade'?'#4ECDC4':'#FF6B6B').setTitle(`${tipo==='verdade'?'🤔 Verdade':'💪 Desafio'}!`).setDescription(lista[Math.floor(Math.random()*lista.length)]).setFooter({text:`Sentinela • VoD • ${interaction.user.username}`}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('escolher').setDescription('🤔 Deixa o Sentinela escolher por você').addStringOption(o => o.setName('opcoes').setDescription('Opções separadas por vírgula. Ex: pizza, hambúrguer, sushi').setRequired(true)),
  async execute(interaction) {
    const opcoes = interaction.options.getString('opcoes').split(',').map(s => s.trim()).filter(Boolean);
    if (opcoes.length < 2) return interaction.reply({content:'❌ Coloca pelo menos 2 opções!', ephemeral:true});
    const escolha = opcoes[Math.floor(Math.random() * opcoes.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('🤔 Minha escolha é...').setDescription(`**${escolha}**! 🎯`).setFooter({text:'Sentinela • Escolher'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('pp').setDescription('📏 Mede o PP de alguém').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getUser('usuario') || interaction.user;
    const seed = u.id + new Date().toDateString();
    const tamanho = seed.split('').reduce((a,c) => a + c.charCodeAt(0), 0) % 31;
    const barra = '=' .repeat(tamanho);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle(`📏 PP de ${u.username}`).setDescription(`8${barra}D\n\n**${tamanho} cm** ${tamanho >= 25 ? '😱' : tamanho >= 15 ? '😏' : tamanho >= 5 ? '😐' : '🤏'}`).setFooter({text:'Sentinela • PP • Puramente fictício'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('gay').setDescription('🏳️‍🌈 Gayômetro!').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getUser('usuario') || interaction.user;
    const seed = u.id + new Date().toDateString();
    const pct = seed.split('').reduce((a,c) => a + c.charCodeAt(0), 0) % 101;
    const bar = '🌈'.repeat(Math.floor(pct/10)) + '⬜'.repeat(10-Math.floor(pct/10));
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF69B4').setTitle(`🏳️‍🌈 Gayômetro de ${u.username}`).setDescription(`${bar}\n\n**${pct}% gay hoje!**`).setFooter({text:'Sentinela • Gayômetro • Puramente fictício'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('impostora').setDescription('📮 Quem é a impostora?').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getUser('usuario') || interaction.user;
    const seed = u.id + new Date().toDateString();
    const pct = seed.split('').reduce((a,c) => a + c.charCodeAt(0), 0) % 101;
    const resultado = pct > 50 ? '🔴 IMPOSTORA!' : '🟢 Não é impostora.';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(pct>50?'#FF0000':'#00C851').setTitle(`📮 Among Us — ${u.username}`).setDescription(`**${resultado}**\n\nChance: **${pct}%**`).setThumbnail(u.displayAvatarURL()).setFooter({text:'Sentinela • Among Us'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('meme').setDescription('😂 Recebe um meme aleatório'),
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const res = await axios.get('https://meme-api.com/gimme', {timeout:5000});
      const m = res.data;
      if (!m?.url) throw new Error();
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle(m.title?.substring(0,256)||'😂 Meme!').setImage(m.url).setFooter({text:`r/${m.subreddit} • Sentinela • Meme`}).setTimestamp()] });
    } catch {
      await interaction.editReply({content:'❌ Não consegui buscar um meme agora. Tente novamente!'});
    }
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('fato').setDescription('🧠 Recebe um fato aleatório em português'),
  async execute(interaction) {
    const fatos = [
      'O mel nunca estraga — mel de 3000 anos foi encontrado nas pirâmides! 🍯',
      'Polvos têm três corações, dois brânquias e um sistêmico! 🐙',
      'Você não consegue hummar com o nariz tampado. Tenta aí! 👃',
      'Uma nuvem típica pesa mais de 500 toneladas! ☁️',
      'Os polvos são daltônicos, mas usam a pele para "ver" cores! 🌈',
      'Bananas são levemente radioativas devido ao potássio-40! 🍌',
      'Formigas nunca dormem e não têm pulmões! 🐜',
      'O coração de um camarão fica na cabeça! 🦐',
      'Cleopatras viveu mais perto de nós no tempo do que das pirâmides! 🏺',
      'Vodka pode ser usada como repelente de insetos! 🍸',
      'O cérebro humano gera energia suficiente para acender uma lâmpada de 25W! 🧠',
      'Golfinhos têm nomes uns para os outros! 🐬',
      'O olho humano pode distinguir cerca de 10 milhões de cores! 👁️',
      'Uma bola de golfe tem 336 covinhas! ⛳',
      'Risos são contagiosos porque o cérebro tem neurônios espelho! 😄',
    ];
    const f = fatos[Math.floor(Math.random() * fatos.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4ECDC4').setTitle('🧠 Fato Aleatório!').setDescription(f).setFooter({text:'Sentinela • Fato'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('conselho').setDescription('💡 Receba um conselho do Sentinela'),
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const res = await axios.get('https://api.adviceslip.com/advice', {timeout:5000});
      const conselho = res.data?.slip?.advice || 'Beba água e dorme cedo. 💧';
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('💡 Conselho do Sentinela').setDescription(`*"${conselho}"*`).setFooter({text:'Sentinela • Conselho'}).setTimestamp()] });
    } catch {
      const conselhos = ['Beba mais água! 💧','Dorme cedo, acorda cedo. 🌅','Use /daily todo dia! 💵','Nunca aposte tudo num jogo só! 🎰','Amigos de verdade fazem /hug sem motivo. 🤗'];
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('💡 Conselho do Sentinela').setDescription(`*"${conselhos[Math.floor(Math.random()*conselhos.length)]}"*`).setFooter({text:'Sentinela • Conselho'})] });
    }
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('avatar').setDescription('🖼️ Veja o avatar de alguém').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getUser('usuario') || interaction.user;
    const url = u.displayAvatarURL({size:1024,extension:'png'});
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`🖼️ Avatar de ${u.username}`).setImage(url).addFields({name:'🔗 Link',value:`[Clique aqui](${url})`}).setFooter({text:'Sentinela • Avatar'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('serverinfo').setDescription('🏰 Informações do servidor'),
  async execute(interaction) {
    const g = interaction.guild;
    await g.fetch();
    const online = g.members.cache.filter(m => m.presence?.status === 'online').size;
    const bots = g.members.cache.filter(m => m.user.bot).size;
    const criado = `<t:${Math.floor(g.createdTimestamp/1000)}:R>`;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`🏰 ${g.name}`).setThumbnail(g.iconURL({size:256})).addFields(
      {name:'🆔 ID',value:g.id,inline:true},
      {name:'👑 Dono',value:`<@${g.ownerId}>`,inline:true},
      {name:'📅 Criado',value:criado,inline:true},
      {name:'👥 Membros',value:`${g.memberCount}`,inline:true},
      {name:'🤖 Bots',value:`${bots}`,inline:true},
      {name:'💬 Canais',value:`${g.channels.cache.size}`,inline:true},
      {name:'🎭 Cargos',value:`${g.roles.cache.size}`,inline:true},
      {name:'😀 Emojis',value:`${g.emojis.cache.size}`,inline:true},
      {name:'🚀 Boosts',value:`${g.premiumSubscriptionCount||0}`,inline:true},
    ).setFooter({text:'Sentinela • Serverinfo'}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('userinfo').setDescription('👤 Informações de um usuário').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getMember('usuario') || interaction.member;
    const user = u.user;
    const roles = u.roles.cache.filter(r => r.id !== interaction.guild.id).sort((a,b) => b.position - a.position).first(5).map(r => `<@&${r.id}>`).join(' ') || 'Nenhum';
    const criado = `<t:${Math.floor(user.createdTimestamp/1000)}:R>`;
    const entrou = u.joinedTimestamp ? `<t:${Math.floor(u.joinedTimestamp/1000)}:R>` : 'N/A';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`👤 ${user.username}`).setThumbnail(user.displayAvatarURL({size:256})).addFields(
      {name:'🆔 ID',value:user.id,inline:true},
      {name:'🤖 Bot?',value:user.bot?'Sim':'Não',inline:true},
      {name:'📅 Conta criada',value:criado,inline:true},
      {name:'📥 Entrou no servidor',value:entrou,inline:true},
      {name:'🎭 Apelido',value:u.nickname||'Nenhum',inline:true},
      {name:'🏷️ Top cargos',value:roles,inline:false},
    ).setFooter({text:'Sentinela • Userinfo'}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('enquete').setDescription('📊 Cria uma enquete rápida')
    .addStringOption(o => o.setName('pergunta').setDescription('Pergunta').setRequired(true))
    .addStringOption(o => o.setName('opcao1').setDescription('Opção 1').setRequired(true))
    .addStringOption(o => o.setName('opcao2').setDescription('Opção 2').setRequired(true))
    .addStringOption(o => o.setName('opcao3').setDescription('Opção 3').setRequired(false))
    .addStringOption(o => o.setName('opcao4').setDescription('Opção 4').setRequired(false)),
  async execute(interaction) {
    const pergunta = interaction.options.getString('pergunta');
    const opcoes = [
      interaction.options.getString('opcao1'),
      interaction.options.getString('opcao2'),
      interaction.options.getString('opcao3'),
      interaction.options.getString('opcao4'),
    ].filter(Boolean);
    const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣'];
    const desc = opcoes.map((o,i) => `${emojis[i]} ${o}`).join('\n');
    const msg = await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4ECDC4').setTitle(`📊 ${pergunta}`).setDescription(desc).setFooter({text:`Enquete por ${interaction.user.username} • Sentinela`}).setTimestamp()], fetchReply:true });
    for (let i = 0; i < opcoes.length; i++) await msg.react(emojis[i]).catch(()=>{});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('sortear').setDescription('🎲 Sorteia alguém aleatório do servidor').addRoleOption(o => o.setName('cargo').setDescription('Filtrar por cargo').setRequired(false)),
  async execute(interaction) {
    await interaction.deferReply();
    const cargo = interaction.options.getRole('cargo');
    let membros = await interaction.guild.members.fetch();
    membros = membros.filter(m => !m.user.bot);
    if (cargo) membros = membros.filter(m => m.roles.cache.has(cargo.id));
    if (!membros.size) return interaction.editReply('❌ Nenhum membro encontrado!');
    const sorteado = membros.random();
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🎲 Sorteio!').setDescription(`O sorteado foi... **${sorteado}**! 🎉`).setThumbnail(sorteado.user.displayAvatarURL()).setFooter({text:'Sentinela • Sortear'}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('say').setDescription('💬 Faz o Sentinela falar').addStringOption(o => o.setName('mensagem').setDescription('O que dizer?').setRequired(true)).setDefaultMemberPermissions(8),
  async execute(interaction) {
    await interaction.reply({content:'✅',ephemeral:true});
    await interaction.channel.send(interaction.options.getString('mensagem'));
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('blackjack').setDescription('🃏 Jogue Blackjack contra o Sentinela!').addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const aposta = interaction.options.getInteger('aposta');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ content: `❌ Moedas insuficientes! Você tem **${user.aura.toLocaleString('pt-BR')} ✨**`, ephemeral: true });
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
          return i.update({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🃏 Estourou! Você perdeu!').setDescription(`Suas cartas: ${pJ.join(' ')} = **${soma(pJ)}**\n💸 Perdeu **-${aposta.toLocaleString('pt-BR')} ✨**`)], components: [] });
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

commands.push({
  data: new SlashCommandBuilder().setName('jokenpo').setDescription('🤜 Jokenpô com aposta de Moedas!').addUserOption(o => o.setName('oponente').setDescription('Quem desafiar').setRequired(true)).addIntegerOption(o => o.setName('aposta').setDescription('Aposta em Moedas').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const oponente = interaction.options.getUser('oponente');
    const aposta = interaction.options.getInteger('aposta');
    if (oponente.bot || oponente.id === interaction.user.id) return interaction.reply({ content: '❌ Alvo inválido!', ephemeral: true });
    const u1 = getUser(interaction.user.id, interaction.user.username);
    const u2 = getUser(oponente.id, oponente.username);
    if (u1.aura < aposta || u2.aura < aposta) return interaction.reply({ content: '❌ Um dos jogadores não tem Moedas suficiente!', ephemeral: true });
    const opts = { pedra: '✊', papel: '🖐️', tesoura: '✌️' };
    const row = new ActionRowBuilder().addComponents(Object.entries(opts).map(([k,v]) => new ButtonBuilder().setCustomId(`jkp_${k}`).setLabel(`${v} ${k}`).setStyle(ButtonStyle.Primary)));
    const escolhas = {};
    const msg = await interaction.reply({ content: `${interaction.user} vs ${oponente} — apostando **${aposta} ✨**\nAmbos escolham!`, components: [row], fetchReply: true });
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
      await msg.edit({ content: `${interaction.user} ${opts[c1]} vs ${opts[c2]} ${oponente}\n\n${res}\n**Aposta:** ${aposta} ✨`, components: [] });
    });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('flipacoin').setDescription('🪙 Cara ou Coroa com aposta!').addStringOption(o => o.setName('escolha').setDescription('Cara ou Coroa').setRequired(true).addChoices({ name: '👤 Cara', value: 'cara' }, { name: '👑 Coroa', value: 'coroa' })).addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(10)),
  async execute(interaction) {
    const escolha = interaction.options.getString('escolha');
    const aposta = interaction.options.getInteger('aposta');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ content: '❌ Moedas insuficientes!', ephemeral: true });
    const resultado = Math.random() < 0.5 ? 'cara' : 'coroa';
    if (escolha === resultado) {
      addAura(interaction.user.id, aposta);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('🪙 Você acertou!').setDescription(`A moeda deu **${resultado === 'cara' ? '👤 Cara' : '👑 Coroa'}**!\n💰 Ganhou **+${aposta.toLocaleString('pt-BR')} 💵 Moedas**!`)] });
    } else {
      removeAura(interaction.user.id, aposta);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🪙 Errou!').setDescription(`A moeda deu **${resultado === 'cara' ? '👤 Cara' : '👑 Coroa'}**!\n💸 Perdeu **-${aposta.toLocaleString('pt-BR')} 💵 Moedas**`)] });
    }
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('nivel').setDescription('⭐ Veja seu nível de XP').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const u = getUser(alvo.id, alvo.username);
    const xpNec = u.nivel * 500;
    const pct = Math.floor((u.xp / xpNec) * 20);
    const bar = '▓'.repeat(pct) + '░'.repeat(20 - pct);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`⭐ Nível de ${alvo.username}`).setDescription(`**Nível ${u.nivel}**\n\n\`[${bar}]\` ${u.xp}/${xpNec} XP`).setThumbnail(alvo.displayAvatarURL()).setFooter({ text: 'Sentinela • XP' })] });
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('missao').setDescription('📋 Veja sua missão diária'),
  async execute(interaction) {
    const seed = interaction.user.id + new Date().toDateString();
    const idx = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % missoes.length;
    const m = missoes[idx];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('📋 Missão Diária!').setDescription(`**Missão:** ${m.txt}\n\n**Recompensa:** +${m.recompensa} 💵 Moedas ao completar manualmente com /resgatar_missao`).setFooter({ text: 'Sentinela • Missão Diária' }).setTimestamp()] });
  },
});

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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('📋 Missão Resgatada!').setDescription(`Você resgatou **+${m.recompensa} 💵 Moedas**!`).setFooter({ text: 'Sentinela • Missão' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('roleta').setDescription('🎡 Aposte na roleta russa de Moedas!').addIntegerOption(o => o.setName('aposta').setDescription('Quanto apostar').setRequired(true).setMinValue(10)).addIntegerOption(o => o.setName('numero').setDescription('Número (0–36)').setRequired(true).setMinValue(0).setMaxValue(36)),
  async execute(interaction) {
    const aposta = interaction.options.getInteger('aposta');
    const numero = interaction.options.getInteger('numero');
    const user = getUser(interaction.user.id, interaction.user.username);
    if (user.aura < aposta) return interaction.reply({ content: '❌ Moedas insuficientes!', ephemeral: true });
    const resultado = Math.floor(Math.random() * 37);
    if (numero === resultado) {
      const ganho = aposta * 35;
      addAura(interaction.user.id, ganho);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🎡 JACKPOT NA ROLETA!!').setDescription(`A roleta parou no **${resultado}**!\n\n🤑 Você ganhou **+${ganho.toLocaleString('pt-BR')} 💵 Moedas**! (x35)`)] });
    } else {
      removeAura(interaction.user.id, aposta);
      return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B6B').setTitle('🎡 Roleta').setDescription(`A roleta parou no **${resultado}** (você escolheu ${numero}).\n💸 Perdeu **-${aposta.toLocaleString('pt-BR')} ✨**`)] });
    }
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('top_global').setDescription('🏆 Ranking de Moedas Totais (histórico) do servidor'),
  async execute(interaction) {
    await interaction.deferReply();
    const top = dbAll('SELECT * FROM usuarios ORDER BY aura_total DESC LIMIT 10', []);
    const linhas = await Promise.all(top.map(async (u, i) => {
      let nome; try { const m = await interaction.guild.members.fetch(u.id).catch(() => null); nome = m ? m.displayName : u.username; } catch { nome = u.username; }
      return `**${i + 1}.** **${nome}** — ✨ ${u.aura_total.toLocaleString('pt-BR')} (total acumulado)`;
    }));
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Ranking Moedas Totais').setDescription(linhas.join('\n')).setFooter({ text: 'Sentinela • Top Global' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('clima').setDescription('🌤️ Veja o clima (fictício) do servidor'),
  async execute(interaction) {
    const c = climas[Math.floor(Math.random() * climas.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#87CEEB').setTitle('🌤️ Previsão do Tempo').setDescription(`**Hoje no servidor:**\n${c}`).setFooter({ text: 'Sentinela • Clima • Fictício' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('piada').setDescription('😂 Receba uma piada aleatória'),
  async execute(interaction) {
    const p = piadas[Math.floor(Math.random() * piadas.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD166').setTitle('😂 Piada!').addFields({ name: '❓ Pergunta', value: p.p }, { name: '😄 Resposta', value: p.r }).setFooter({ text: 'Sentinela • Piada' })] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('curiosidade').setDescription('🧠 Receba uma curiosidade aleatória'),
  async execute(interaction) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4ECDC4').setTitle('🧠 Curiosidade do Dia!').setDescription(curiosidades[Math.floor(Math.random() * curiosidades.length)]).setFooter({ text: 'Sentinela • Curiosidade' })] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('fortuna').setDescription('🔮 Consulte sua fortuna do dia!'),
  async execute(interaction) {
    const seed = interaction.user.id + new Date().toDateString();
    const idx = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % fortunas.length;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('🔮 Sua Fortuna Hoje!').setDescription(fortunas[idx]).setThumbnail('https://i.imgur.com/8vZl5.gif').setFooter({ text: `Sentinela • Fortuna de ${interaction.user.username}` }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('streak').setDescription('🔥 Veja seu streak de /daily consecutivo'),
  async execute(interaction) {
    const u = getUser(interaction.user.id, interaction.user.username);
    const streak = dbGet('SELECT streak, last_streak FROM usuarios WHERE id = ?', [interaction.user.id]);
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF6B00').setTitle('🔥 Streak de Daily').setDescription(`Você tem **${u.nivel}** dias de nível acumulado.\nUse **/daily** todo dia para manter o streak!`).setFooter({ text: 'Sentinela • Streak' })] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('comparar').setDescription('⚖️ Compare a Moedas de duas pessoas').addUserOption(o => o.setName('usuario1').setDescription('Primeiro usuário').setRequired(true)).addUserOption(o => o.setName('usuario2').setDescription('Segundo usuário').setRequired(false)),
  async execute(interaction) {
    const u1 = interaction.options.getUser('usuario1');
    const u2 = interaction.options.getUser('usuario2') || interaction.user;
    const d1 = getUser(u1.id, u1.username);
    const d2 = getUser(u2.id, u2.username);
    const venc = d1.aura >= d2.aura ? u1 : u2;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('⚖️ Comparação de Moedas').addFields({ name: u1.username, value: `✨ ${d1.aura.toLocaleString('pt-BR')}`, inline: true }, { name: '⚖️ vs', value: '​', inline: true }, { name: u2.username, value: `✨ ${d2.aura.toLocaleString('pt-BR')}`, inline: true }, { name: '🏆 Liderando', value: `**${venc.username}** está na frente!` }).setFooter({ text: 'Sentinela • Comparar' })] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('cacar').setDescription('🏹 Vá caçar para ganhar Moedas!'),
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#8B4513').setTitle(`🏹 Você caçou um ${animal.nome}! ${animal.emoji}`).setDescription(`**+${ganho.toLocaleString('pt-BR')} 💵 Moedas** e **+${animal.xp} XP**!`).setFooter({ text: 'Sentinela • Caça • CD: 2h' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('pescar').setDescription('🎣 Vá pescar para ganhar Moedas!'),
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#4682B4').setTitle(`🎣 Pescou um ${peixe.nome}! ${peixe.emoji}`).setDescription(`**+${ganho.toLocaleString('pt-BR')} 💵 Moedas** e **+${peixe.xp} XP**!`).setFooter({ text: 'Sentinela • Pesca • CD: 30min' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('minerar').setDescription('⛏️ Mine recursos para ganhar Moedas!'),
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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#8B4513').setTitle(`⛏️ Você minerou ${minerio.nome}! ${minerio.emoji}`).setDescription(`**+${ganho.toLocaleString('pt-BR')} 💵 Moedas** e **+${minerio.xp} XP**!`).setFooter({ text: 'Sentinela • Mineração • CD: 1h' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('lembrete').setDescription('⏰ Configure um lembrete').addStringOption(o => o.setName('mensagem').setDescription('O que lembrar?').setRequired(true)).addIntegerOption(o => o.setName('minutos').setDescription('Em quantos minutos?').setRequired(true).setMinValue(1).setMaxValue(1440)),
  async execute(interaction) {
    const msg = interaction.options.getString('mensagem');
    const min = interaction.options.getInteger('minutos');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('⏰ Lembrete configurado!').setDescription(`Vou te lembrar em **${min} minutos**:\n> ${msg}`).setFooter({ text: 'Sentinela • Lembrete' })] });
    setTimeout(async () => {
      try {
        await interaction.user.send({ embeds: [new EmbedBuilder().setColor('#FF9F1C').setTitle('⏰ Lembrete!').setDescription(`Você pediu pra eu te lembrar:\n> ${msg}`).setFooter({ text: 'Sentinela • Lembrete' }).setTimestamp()] });
      } catch { await interaction.channel.send(`${interaction.user} ⏰ **Lembrete:** ${msg}`).catch(() => {}); }
    }, min * 60000);
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('resumo').setDescription('📊 Resumo completo das suas estatísticas').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario') || interaction.user;
    const u = getUser(alvo.id, alvo.username);
    const inv = getInventario(alvo.id);
    const pos = dbAll('SELECT id FROM usuarios ORDER BY aura DESC', []).findIndex(r => r.id === alvo.id) + 1;
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`📊 Resumo de ${alvo.username}`).setThumbnail(alvo.displayAvatarURL()).addFields(
      { name: '💵 Moedas Atual', value: u.aura.toLocaleString('pt-BR'), inline: true },
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

commands.push({
  data: new SlashCommandBuilder().setName('sorte').setDescription('🍀 Veja seu índice de sorte de hoje'),
  async execute(interaction) {
    const seed = interaction.user.id + new Date().toDateString();
    const sorte = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 101;
    const emoji = sorte >= 80 ? '🍀' : sorte >= 60 ? '😊' : sorte >= 40 ? '😐' : sorte >= 20 ? '😬' : '💀';
    const msg = sorte >= 80 ? 'Dia de sorte! Aposte tudo!' : sorte >= 60 ? 'Dia razoável, tente o crime!' : sorte >= 40 ? 'Mediano. Jogue pelo baixo.' : sorte >= 20 ? 'Cuidado hoje. Fique no /daily.' : 'Fique em casa. Sério.';
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🍀 Índice de Sorte').setDescription(`${emoji} **${sorte}% de sorte hoje!**\n\n${msg}`).setFooter({ text: `Sentinela • Sorte de ${interaction.user.username}` }).setTimestamp()] });
  },
});

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
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(aceite ? '#FF69B4' : '#808080').setTitle(aceite ? '💘 Romance!' : '💔 Não foi dessa vez...').setDescription(`${interaction.user} tentou namorar ${alvo}!\n\n${resposta}`).setFooter({ text: 'Sentinela • Romance' }).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('trabalho_list').setDescription('💼 Lista todos os trabalhos disponíveis'),
  async execute(interaction) {
    const linhas = trabalhos.map(t => `${t.emoji} **${t.nome}** — ✨ ${t.min}–${t.max} Aura`).join('\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00C851').setTitle('💼 Trabalhos Disponíveis').setDescription(linhas).setFooter({ text: 'Sentinela • /trabalho' })] });
  },
});

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

commands.push({
  data: new SlashCommandBuilder().setName('banner').setDescription('🖼️ Veja o banner de alguém').addUserOption(o => o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const u = await (interaction.options.getUser('usuario') || interaction.user).fetch();
    if (!u.banner) return interaction.reply({content:'❌ Este usuário não tem banner!', ephemeral:true});
    const url = u.bannerURL({size:1024});
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#7B2FBE').setTitle(`🖼️ Banner de ${u.username}`).setImage(url).setFooter({text:'Sentinela • Banner'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('pergunta').setDescription('❓ Gera uma pergunta para quebrar o gelo'),
  async execute(interaction) {
    const perguntas = [
      'Se você pudesse ter qualquer superpoder, qual seria e por quê?',
      'Qual música você ouviria pelo resto da vida se tivesse que escolher só uma?',
      'Prefere viver sem internet ou sem ar condicionado para sempre?',
      'Se pudesse jantar com qualquer pessoa da história, quem escolheria?',
      'Qual é o seu app mais aberto no celular hoje?',
      'Prefere saber a data da sua morte ou como vai morrer?',
      'Se o seu pet pudesse falar por 1 minuto, o que você acha que diria?',
      'Qual habilidade você gostaria de dominar instantaneamente?',
      'O que você faria com 24h completamente livres e sem internet?',
      'Qual é a coisa mais estranha que você já comeu?',
    ];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD166').setTitle('❓ Pergunta para quebrar o gelo').setDescription(perguntas[Math.floor(Math.random()*perguntas.length)]).setFooter({text:'Sentinela • Pergunta'})] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('seria').setDescription('💭 Você seria capaz de...?'),
  async execute(interaction) {
    const acoes = [
      'Ficar 24h sem celular por R$1.000?','Comer pizza sem queijo por R$500?',
      'Ficar 1 semana sem redes sociais?','Mudar de cidade por amor?',
      'Trabalhar de graça num emprego dos sonhos?','Morar sozinho numa ilha deserta por 1 mês por R$50.000?',
      'Assistir 48h de TV ao vivo sem dormir?','Aprender um idioma em 3 meses?',
      'Ficar sem ouvir música por 1 ano por R$10.000?','Deletar todas as fotos do celular por R$2.000?',
    ];
    const acao = acoes[Math.floor(Math.random()*acoes.length)];
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('seria_sim').setLabel('✅ Seria!').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('seria_nao').setLabel('❌ Jamais!').setStyle(ButtonStyle.Danger)
    );
    const msg = await interaction.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('💭 Você seria capaz de...?').setDescription(`**${acao}**`).setFooter({text:'Sentinela • Seria'})], components:[row], fetchReply:true});
    let sim=0, nao=0;
    const votos = new Set();
    const col = msg.createMessageComponentCollector({time:30000});
    col.on('collect', async i => {
      if (votos.has(i.user.id)) return i.reply({content:'Você já votou!',ephemeral:true});
      votos.add(i.user.id);
      if(i.customId==='seria_sim') sim++; else nao++;
      await i.update({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('💭 Você seria capaz de...?').setDescription(`**${acao}**\n\n✅ Seria: **${sim}** | ❌ Jamais: **${nao}**`).setFooter({text:`${votos.size} votos • Sentinela • Seria`})], components:[row]});
    });
    col.on('end', ()=>msg.edit({components:[]}).catch(()=>{}));
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('nunca').setDescription('🙈 Nunca nunca! (Nunca eu nunca)'),
  async execute(interaction) {
    const frases = [
      'Nunca fui banido de um servidor do Discord','Nunca enviei uma mensagem para a pessoa errada',
      'Nunca fingi estar ocupado para não responder','Nunca ri de uma piada que não entendi',
      'Nunca dei like no próprio post','Nunca terminei uma série do Netflix em um dia',
      'Nunca menti na minha bio','Nunca joguei videogame depois das 2h da manhã',
      'Nunca fui multado','Nunca chorei com um filme de animação',
    ];
    const frase = frases[Math.floor(Math.random()*frases.length)];
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nunca_ja').setLabel('😳 Já fiz isso!').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('nunca_n').setLabel('😇 Nunca!').setStyle(ButtonStyle.Success)
    );
    const msg = await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF6B6B').setTitle('🙈 Nunca Nunca!').setDescription(`**${frase}**`).setFooter({text:'Sentinela • Nunca Nunca'})],components:[row],fetchReply:true});
    let ja=0,nao=0; const votos=new Set();
    const col = msg.createMessageComponentCollector({time:30000});
    col.on('collect', async i=>{
      if(votos.has(i.user.id)) return i.reply({content:'Já votou!',ephemeral:true});
      votos.add(i.user.id);
      if(i.customId==='nunca_ja') ja++; else nao++;
      await i.update({embeds:[new EmbedBuilder().setColor('#FF6B6B').setTitle('🙈 Nunca Nunca!').setDescription(`**${frase}**\n\n😳 Já fiz: **${ja}** | 😇 Nunca: **${nao}**`).setFooter({text:`${votos.size} votos`})],components:[row]});
    });
    col.on('end',()=>msg.edit({components:[]}).catch(()=>{}));
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('elogiar').setDescription('💐 Elogie alguém!').addUserOption(o=>o.setName('usuario').setDescription('Quem elogiar?').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getUser('usuario') || interaction.user;
    const elogios = [
      'é incrível e faz este servidor melhor só de existir! ✨',
      'tem uma energia contagiante! 🌟','é a pessoa mais legal por aqui! 😄',
      'irradia positividade! ☀️','merece todo o bem do mundo! 💖',
      'é um gênio disfarçado de pessoa normal! 🧠','faz as pessoas ao redor sorrirem! 😊',
      'tem um coração enorme! 💝','é pura luz nesse servidor! 🕯️',
    ];
    const e = elogios[Math.floor(Math.random()*elogios.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFB6C1').setTitle('💐 Elogio!').setDescription(`${u} ${e}`).setFooter({text:`Elogio de ${interaction.user.username} • Sentinela`}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('xingo').setDescription('😤 Xinga alguém (de forma cômica!)').addUserOption(o=>o.setName('usuario').setDescription('Quem xingar?').setRequired(false)),
  async execute(interaction) {
    const u = interaction.options.getUser('usuario') || interaction.user;
    const xingamentos = [
      'seu bugado de plantão! 🐛','você come o biscoito antes do leite! 😱',
      'você coloca o leite antes do cereal! 🥣','você usa Comic Sans voluntariamente! 😤',
      'você deixa as notificações acumular! 🔴','você responde áudios com áudios de 5 minutos! 📻',
      'você nunca vai buscar as coisas da máquina! 🧺','você usa o fone sem case no celular! 📱',
    ];
    const x = xingamentos[Math.floor(Math.random()*xingamentos.length)];
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#FF4500').setTitle('😤 Xingamento!').setDescription(`${u}, ${x}`).setFooter({text:`Por ${interaction.user.username} • Sentinela • Só de brincadeira!`}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('chute').setDescription('🎯 Tente adivinhar um número entre 1 e 100!'),
  async execute(interaction) {
    const numero = Math.floor(Math.random() * 100) + 1;
    const tentativas = 5;
    let restantes = tentativas;
    const row = (disabled=false) => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('chute_btn').setLabel(`🎯 Chutar (${restantes} tentativas)`).setStyle(ButtonStyle.Primary).setDisabled(disabled)
    );
    const msg = await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle('🎯 Adivinhe o Número!').setDescription(`Pensei num número entre **1 e 100**.\nVocê tem **${tentativas} tentativas**!\nUse o botão e responda no chat.`).setFooter({text:'Sentinela • Jogo de Adivinhação'})],components:[row()],fetchReply:true});
    const btnCol = msg.createMessageComponentCollector({filter:i=>i.user.id===interaction.user.id,time:60000});
    btnCol.on('collect', async i => {
      await i.reply({content:'💬 Digite seu chute agora (número de 1 a 100):',ephemeral:true});
      const msgCol = interaction.channel.createMessageCollector({filter:m=>m.author.id===interaction.user.id,time:15000,max:1});
      msgCol.on('collect', async m => {
        m.delete().catch(()=>{});
        const chute = parseInt(m.content);
        if(isNaN(chute)||chute<1||chute>100) return interaction.followUp({content:'❌ Número inválido!',ephemeral:true});
        restantes--;
        if(chute===numero) {
          btnCol.stop();
          return msg.edit({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('🎯 Acertou!').setDescription(`O número era **${numero}**! 🎉\nVocê acertou com **${tentativas-restantes}** tentativa(s)!`)],components:[row(true)]});
        }
        const dica = chute < numero ? '⬆️ Mais alto!' : '⬇️ Mais baixo!';
        if(restantes===0) {
          btnCol.stop();
          return msg.edit({embeds:[new EmbedBuilder().setColor('#FF6B6B').setTitle('❌ Game Over!').setDescription(`O número era **${numero}**. Tentativas esgotadas!`)],components:[row(true)]});
        }
        await msg.edit({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle('🎯 Adivinhe o Número!').setDescription(`Seu chute: **${chute}** — ${dica}\n**${restantes} tentativas** restantes!`)],components:[row()]});
      });
    });
    btnCol.on('end',()=>msg.edit({components:[]}).catch(()=>{}));
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('quiz').setDescription('🧠 Quiz de conhecimentos gerais!'),
  async execute(interaction) {
    const q = quizzes[Math.floor(Math.random()*quizzes.length)];
    const letras = ['A','B','C','D'];
    const row = new ActionRowBuilder().addComponents(q.ops.map((op,i) => new ButtonBuilder().setCustomId(`quiz_${i}`).setLabel(`${letras[i]}) ${op}`).setStyle(ButtonStyle.Primary)));
    const msg = await interaction.reply({embeds:[new EmbedBuilder().setColor('#4ECDC4').setTitle('🧠 Quiz!').setDescription(`**${q.q}**`).setFooter({text:'Sentinela • Quiz • 20s'})],components:[row],fetchReply:true});
    const col = msg.createMessageComponentCollector({filter:i=>i.user.id===interaction.user.id,time:20000,max:1});
    col.on('collect', async i=>{
      const escolha = parseInt(i.customId.split('_')[1]);
      const acertou = escolha === q.certa;
      if(acertou) { addAura(interaction.user.id, 100); addXP(interaction.user.id, 50); }
      await i.update({embeds:[new EmbedBuilder().setColor(acertou?'#00C851':'#FF6B6B').setTitle(acertou?'✅ Correto!':'❌ Errado!').setDescription(`**${q.q}**\n\nResposta: **${letras[q.certa]}) ${q.ops[q.certa]}**\n\n${q.exp}${acertou?'\n\n+100 💵 +50 XP':''}`)],components:[]});
    });
    col.on('end',(_,r)=>{if(r==='time') msg.edit({embeds:[EmbedBuilder.from(msg.embeds[0]).setTitle('⏰ Tempo esgotado!').setColor('#808080')],components:[]}).catch(()=>{})});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('memorizacao').setDescription('🧠 Jogo de memorização de sequência!'),
  async execute(interaction) {
    const emojis = ['🔴','🔵','🟢','🟡','🟣'];
    const seq = Array.from({length:4}, ()=>emojis[Math.floor(Math.random()*emojis.length)]);
    const msg = await interaction.reply({embeds:[new EmbedBuilder().setColor('#7B2FBE').setTitle('🧠 Memorize a sequência!').setDescription(seq.join(' ')).setFooter({text:'Sentinela • Memorização • 10s para memorizar'})],fetchReply:true});
    await new Promise(r=>setTimeout(r,10000));
    const row = new ActionRowBuilder().addComponents(emojis.map(e=>new ButtonBuilder().setCustomId(`mem_${e}`).setLabel(e).setStyle(ButtonStyle.Primary)));
    let atual=0, respostas=[];
    await msg.edit({embeds:[new EmbedBuilder().setColor('#7B2FBE').setTitle('🧠 Qual foi a sequência?').setDescription('Clique nos emojis na ordem correta!').setFooter({text:`0/${seq.length} selecionados`})],components:[row]});
    const col = msg.createMessageComponentCollector({filter:i=>i.user.id===interaction.user.id,time:30000});
    col.on('collect', async i=>{
      respostas.push(i.customId.replace('mem_',''));
      atual++;
      if(atual===seq.length) {
        col.stop();
        const acertou = respostas.every((r,i)=>r===seq[i]);
        if(acertou) { addAura(interaction.user.id,200); addXP(interaction.user.id,75); }
        return i.update({embeds:[new EmbedBuilder().setColor(acertou?'#00C851':'#FF6B6B').setTitle(acertou?'✅ Perfeito!':'❌ Errou!').setDescription(`Sequência correta: ${seq.join(' ')}\nSua resposta: ${respostas.join(' ')}${acertou?'\n\n+200 💵 +75 XP':''}`)],components:[]});
      }
      await i.update({embeds:[new EmbedBuilder().setColor('#7B2FBE').setTitle('🧠 Continue...').setDescription(`Selecionado: ${respostas.join(' ')}`).setFooter({text:`${atual}/${seq.length} selecionados`})],components:[row]});
    });
    col.on('end',(_,r)=>{if(r==='time') msg.edit({components:[]}).catch(()=>{})});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('dados_rpg').setDescription('🎲 Role dados no estilo RPG!').addStringOption(o=>o.setName('dados').setDescription('Ex: 2d6, 1d20, 3d8').setRequired(true)),
  async execute(interaction) {
    const input = interaction.options.getString('dados').toLowerCase().trim();
    const match = input.match(/^(\d+)d(\d+)$/);
    if(!match) return interaction.reply({content:'❌ Formato inválido! Use: `2d6`, `1d20`, `3d8`',ephemeral:true});
    const qtd = Math.min(parseInt(match[1]),20), lados = Math.min(parseInt(match[2]),1000);
    const rolls = Array.from({length:qtd},()=>Math.floor(Math.random()*lados)+1);
    const total = rolls.reduce((a,b)=>a+b,0);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF6B00').setTitle(`🎲 ${qtd}d${lados}`).addFields({name:'🎯 Resultados',value:rolls.join(', '),inline:true},{name:'➕ Total',value:`**${total}**`,inline:true}).setFooter({text:'Sentinela • Dados RPG'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('forca').setDescription('📝 Jogue Forca!'),
  async execute(interaction) {
    const palavras = ['discord','sentinela','moedas','cowboy','servidor','giveaway','inventario','casamento','duelo','ranking','trabalho','pirata','aventura','tesouro','explorador'];
    const palavra = palavras[Math.floor(Math.random()*palavras.length)];
    let erros=0, letras=new Set(), maxErros=6;
    const display = ()=>palavra.split('').map(l=>letras.has(l)?l:'_').join(' ');
    const forca = e=>['😃','😐','😟','😨','😰','😱','💀'][e];
    const embed = ()=>new EmbedBuilder().setColor(erros>=maxErros?'#FF0000':'#7B2FBE').setTitle('📝 Forca!').setDescription(`\`${display()}\`\n\n${forca(erros)} Erros: **${erros}/${maxErros}**\nLetras: ${[...letras].join(', ')||'nenhuma'}`).setFooter({text:'Sentinela • Forca • 2min'});
    const row = ()=>new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('forca_letra').setLabel('✏️ Digitar letra').setStyle(ButtonStyle.Primary).setDisabled(erros>=maxErros||!display().includes('_')));
    const msg = await interaction.reply({embeds:[embed()],components:[row()],fetchReply:true});
    const col = msg.createMessageComponentCollector({filter:i=>i.user.id===interaction.user.id,time:120000});
    col.on('collect', async i=>{
      await i.reply({content:'✏️ Digite uma letra:',ephemeral:true});
      const mc = interaction.channel.createMessageCollector({filter:m=>m.author.id===interaction.user.id,time:15000,max:1});
      mc.on('collect', async m=>{
        m.delete().catch(()=>{});
        const letra = m.content.toLowerCase()[0];
        if(!letra||!/[a-záàãâéèêíìîóòõôúùûç]/.test(letra)) return;
        if(letras.has(letra)) return interaction.followUp({content:'Já tentou essa letra!',ephemeral:true});
        letras.add(letra);
        if(!palavra.includes(letra)) erros++;
        const venceu = !display().includes('_');
        const perdeu = erros>=maxErros;
        if(venceu){col.stop();addAura(interaction.user.id,300);addXP(interaction.user.id,100);}
        if(perdeu) col.stop();
        await msg.edit({embeds:[new EmbedBuilder().setColor(venceu?'#00C851':perdeu?'#FF0000':'#7B2FBE').setTitle(venceu?'🎉 Acertou!':perdeu?'💀 Perdeu!':'📝 Forca!').setDescription(venceu?`Palavra: **${palavra}**\n\n+300 💵 +100 XP`:perdeu?`A palavra era: **${palavra}**`:`\`${display()}\`\n\n${forca(erros)} Erros: **${erros}/${maxErros}**\nLetras: ${[...letras].join(', ')}`)],components:[row()]});
      });
    });
    col.on('end',()=>msg.edit({components:[]}).catch(()=>{}));
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('velocidade').setDescription('⌨️ Teste sua velocidade de digitação!'),
  async execute(interaction) {
    const textos = ['o sentinela é o melhor bot do discord','moedas crescem quando você trabalha todo dia','o cowboy sempre vence no final','giveaway é a melhor coisa da vida','discord é onde os amigos se encontram'];
    const texto = textos[Math.floor(Math.random()*textos.length)];
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('⌨️ Teste de Velocidade!').setDescription(`Digite exatamente:\n\n**\`${texto}\`**\n\nVocê tem 30 segundos!`).setFooter({text:'Sentinela • Velocidade'})],fetchReply:true});
    const inicio = Date.now();
    const mc = interaction.channel.createMessageCollector({filter:m=>m.author.id===interaction.user.id,time:30000,max:1});
    mc.on('collect', async m=>{
      m.delete().catch(()=>{});
      const tempo = ((Date.now()-inicio)/1000).toFixed(2);
      const acertou = m.content.toLowerCase().trim()===texto;
      const palavras = texto.split(' ').length;
      const wpm = acertou ? Math.round(palavras/(parseFloat(tempo)/60)) : 0;
      if(acertou && wpm>60) addAura(interaction.user.id, Math.min(wpm, 500));
      await interaction.followUp({embeds:[new EmbedBuilder().setColor(acertou?'#00C851':'#FF6B6B').setTitle(acertou?'✅ Correto!':'❌ Errou!').addFields({name:'⏱️ Tempo',value:`${tempo}s`,inline:true},{name:'📝 WPM',value:acertou?`${wpm}`:'-',inline:true},{name:'✏️ Digitado',value:m.content.substring(0,100),inline:false}).setFooter({text:acertou&&wpm>60?`+${Math.min(wpm,500)} 💵`:'Sentinela • Velocidade'})]});
    });
    mc.on('end',(_,r)=>{if(r==='time') interaction.followUp({content:'⏰ Tempo esgotado!',ephemeral:true}).catch(()=>{})});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('warn').setDescription('⚠️ Adverte um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).addStringOption(o=>o.setName('motivo').setDescription('Motivo').setRequired(false)).setDefaultMemberPermissions(8192),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    const motivo = interaction.options.getString('motivo')||'Sem motivo';
    if(!alvo) return interaction.reply({content:'❌ Membro não encontrado!',ephemeral:true});
    dbRun('INSERT INTO inventario (user_id, item, quantidade) VALUES (?,?,1) ON CONFLICT DO NOTHING', []);
    addItem(alvo.id, `warn:${motivo}:${Date.now()}`);
    const warns = getInventario(alvo.id).filter(i=>i.item.startsWith('warn:'));
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle('⚠️ Advertência').addFields({name:'Membro',value:`${alvo}`,inline:true},{name:'Motivo',value:motivo,inline:true},{name:'Total',value:`${warns.length} warn(s)`,inline:true}).setFooter({text:`Por ${interaction.user.username} • Sentinela`}).setTimestamp()]});
    try { await alvo.user.send({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle(`⚠️ Você recebeu uma advertência em ${interaction.guild.name}`).setDescription(`**Motivo:** ${motivo}\n**Total:** ${warns.length} warn(s)`)]}); } catch {}
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('warns').setDescription('⚠️ Ver advertências de um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).setDefaultMemberPermissions(8192),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    if(!alvo) return interaction.reply({content:'❌ Membro não encontrado!',ephemeral:true});
    const warns = getInventario(alvo.id).filter(i=>i.item.startsWith('warn:'));
    const lista = warns.map((w,i)=>{const p=w.item.split(':');return `**${i+1}.** ${p[1]} — <t:${Math.floor(parseInt(p[2])/1000)}:R>`;}).join('\n')||'Nenhuma advertência!';
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle(`⚠️ Warns de ${alvo.user.username}`).setDescription(lista).setFooter({text:`Total: ${warns.length} • Sentinela`})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('clearwarns').setDescription('🗑️ Limpa as advertências de um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).setDefaultMemberPermissions(8),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    if(!alvo) return interaction.reply({content:'❌ Membro não encontrado!',ephemeral:true});
    dbRun("DELETE FROM inventario WHERE user_id = ? AND item LIKE 'warn:%'",[alvo.id]);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('🗑️ Warns limpos!').setDescription(`Todas as advertências de ${alvo} foram removidas.`).setFooter({text:'Sentinela • Moderação'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('kick').setDescription('👢 Expulsa um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).addStringOption(o=>o.setName('motivo').setDescription('Motivo').setRequired(false)).setDefaultMemberPermissions(8192),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    const motivo = interaction.options.getString('motivo')||'Sem motivo';
    if(!alvo||!alvo.kickable) return interaction.reply({content:'❌ Não consigo expulsar este membro!',ephemeral:true});
    await alvo.kick(motivo);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle('👢 Membro Expulso!').addFields({name:'Membro',value:`${alvo.user.tag}`,inline:true},{name:'Motivo',value:motivo,inline:true}).setFooter({text:`Por ${interaction.user.username} • Sentinela`}).setTimestamp()]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('ban').setDescription('🔨 Bane um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).addStringOption(o=>o.setName('motivo').setDescription('Motivo').setRequired(false)).setDefaultMemberPermissions(4),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    const motivo = interaction.options.getString('motivo')||'Sem motivo';
    if(!alvo||!alvo.bannable) return interaction.reply({content:'❌ Não consigo banir este membro!',ephemeral:true});
    await alvo.ban({reason:motivo});
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF0000').setTitle('🔨 Membro Banido!').addFields({name:'Membro',value:`${alvo.user.tag}`,inline:true},{name:'Motivo',value:motivo,inline:true}).setFooter({text:`Por ${interaction.user.username} • Sentinela`}).setTimestamp()]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('mute').setDescription('🔇 Silencia um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).addIntegerOption(o=>o.setName('minutos').setDescription('Duração em minutos').setRequired(true).setMinValue(1).setMaxValue(40320)).addStringOption(o=>o.setName('motivo').setDescription('Motivo').setRequired(false)).setDefaultMemberPermissions(8192),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    const min = interaction.options.getInteger('minutos');
    const motivo = interaction.options.getString('motivo')||'Sem motivo';
    if(!alvo) return interaction.reply({content:'❌ Membro não encontrado!',ephemeral:true});
    await alvo.timeout(min*60000, motivo);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FFA500').setTitle('🔇 Membro Silenciado!').addFields({name:'Membro',value:`${alvo}`,inline:true},{name:'Duração',value:`${min} minutos`,inline:true},{name:'Motivo',value:motivo,inline:true}).setFooter({text:`Por ${interaction.user.username} • Sentinela`}).setTimestamp()]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('unmute').setDescription('🔊 Remove silêncio de um membro').addUserOption(o=>o.setName('membro').setDescription('Membro').setRequired(true)).setDefaultMemberPermissions(8192),
  async execute(interaction) {
    const alvo = interaction.options.getMember('membro');
    if(!alvo) return interaction.reply({content:'❌ Membro não encontrado!',ephemeral:true});
    await alvo.timeout(null);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('🔊 Silêncio Removido!').setDescription(`${alvo} pode falar novamente.`).setFooter({text:`Por ${interaction.user.username} • Sentinela`}).setTimestamp()]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('limpar').setDescription('🗑️ Limpa mensagens do canal').addIntegerOption(o=>o.setName('quantidade').setDescription('Quantas mensagens (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)).setDefaultMemberPermissions(8192),
  async execute(interaction) {
    const qt = interaction.options.getInteger('quantidade');
    const deleted = await interaction.channel.bulkDelete(qt,true).catch(()=>null);
    await interaction.reply({content:`🗑️ **${deleted?.size||0}** mensagens deletadas!`,ephemeral:true});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('economia_info').setDescription('💰 Veja estatísticas da economia global do bot'),
  async execute(interaction) {
    await interaction.deferReply();
    const stats = dbGet('SELECT COUNT(*) as total, SUM(aura) as soma, MAX(aura) as max, AVG(aura) as media FROM usuarios', []);
    await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('💰 Economia Global').addFields(
      {name:'👥 Usuários',value:`${stats.total||0}`,inline:true},
      {name:'💵 Total em circulação',value:`${Number(stats.soma||0).toLocaleString('pt-BR')}`,inline:true},
      {name:'🏆 Maior fortuna',value:`${Number(stats.max||0).toLocaleString('pt-BR')}`,inline:true},
      {name:'📊 Média por usuário',value:`${Math.round(stats.media||0).toLocaleString('pt-BR')}`,inline:true},
    ).setFooter({text:'Sentinela • Economia'}).setTimestamp()] });
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('loja_admin').setDescription('🛒 [Admin] Adiciona item à loja')
    .addStringOption(o=>o.setName('nome').setDescription('Nome').setRequired(true))
    .addStringOption(o=>o.setName('descricao').setDescription('Descrição').setRequired(true))
    .addIntegerOption(o=>o.setName('preco').setDescription('Preço').setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName('emoji').setDescription('Emoji').setRequired(false))
    .setDefaultMemberPermissions(8),
  async execute(interaction) {
    const nome = interaction.options.getString('nome');
    const desc = interaction.options.getString('descricao');
    const preco = interaction.options.getInteger('preco');
    const emoji = interaction.options.getString('emoji')||'📦';
    dbRun('INSERT OR IGNORE INTO shop (nome, descricao, preco, emoji) VALUES (?,?,?,?)',[nome,desc,preco,emoji]);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('✅ Item adicionado!').setDescription(`${emoji} **${nome}** por **${preco.toLocaleString('pt-BR')} 💵**`).setFooter({text:'Sentinela • Loja Admin'})],ephemeral:true});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('usar').setDescription('🎒 Use um item do seu inventário').addStringOption(o=>o.setName('item').setDescription('Nome do item').setRequired(true)),
  async execute(interaction) {
    const nomeItem = interaction.options.getString('item');
    const uid = interaction.user.id;
    if (!hasItem(uid, nomeItem)) return interaction.reply({content:`❌ Você não tem **${nomeItem}** no inventário!`,ephemeral:true});
    const efeitos = {
      'Poção de XP': () => { addXP(uid, 500); removeItem(uid,'Poção de XP'); return '⚗️ Você ganhou **+500 XP**!'; },
      'Elixir de Moedas': () => { addAura(uid, 1000); removeItem(uid,'Elixir de Moedas'); return '✨ Você ganhou **+1.000 💵**!'; },
      'Amuleto da Sorte': () => { dbRun('UPDATE usuarios SET last_roubo = ? WHERE id = ?',[new Date(Date.now()-99999999).toISOString(),uid]); removeItem(uid,'Amuleto da Sorte'); return '🍀 Amuleto ativado! Próximo /daily com bônus!'; },
    };
    const efeito = efeitos[nomeItem];
    if (!efeito) return interaction.reply({content:`❌ **${nomeItem}** não tem efeito ativo. Talvez seja para presentear ou equipar!`,ephemeral:true});
    const msg = efeito();
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🎒 Item usado!').setDescription(msg).setFooter({text:'Sentinela • Inventário'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('trabalho_info').setDescription('💼 Veja suas estatísticas de trabalho').addUserOption(o=>o.setName('usuario').setDescription('Usuário').setRequired(false)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario')||interaction.user;
    const u = getUser(alvo.id, alvo.username);
    const prox = u.last_trabalho ? `<t:${Math.floor((new Date(u.last_trabalho).getTime()+3600000)/1000)}:R>` : 'Agora!';
    const proxCrime = u.last_crime ? `<t:${Math.floor((new Date(u.last_crime).getTime()+3600000)/1000)}:R>` : 'Agora!';
    const proxDaily = u.last_daily ? `<t:${Math.floor((new Date(u.last_daily).getTime()+86400000)/1000)}:R>` : 'Agora!';
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle(`💼 Atividades de ${alvo.username}`).addFields(
      {name:'💼 Próximo Trabalho',value:prox,inline:true},
      {name:'🦹 Próximo Crime',value:proxCrime,inline:true},
      {name:'🌟 Próximo Daily',value:proxDaily,inline:true},
      {name:'💵 Moedas atuais',value:Number(u.aura).toLocaleString('pt-BR'),inline:true},
      {name:'⭐ Nível',value:`${u.nivel}`,inline:true},
      {name:'🏆 Total ganho',value:Number(u.aura_total).toLocaleString('pt-BR'),inline:true},
    ).setFooter({text:'Sentinela • Atividades'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('cara_ou_coroa').setDescription('🪙 Cara ou Coroa simples!'),
  async execute(interaction) {
    const r = Math.random()<0.5?'👤 Cara':'👑 Coroa';
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🪙 Cara ou Coroa!').setDescription(`A moeda girou e deu... **${r}**!`).setFooter({text:'Sentinela • Cara ou Coroa'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('numero_secreto').setDescription('🔢 Adivinhe o número secreto (1-1000) e ganhe Moedas!').addIntegerOption(o=>o.setName('chute').setDescription('Seu chute').setRequired(true).setMinValue(1).setMaxValue(1000)),
  async execute(interaction) {
    const chute = interaction.options.getInteger('chute');
    const uid = interaction.user.id;
    const seed = uid + new Date().toDateString();
    const numero = (seed.split('').reduce((a,c)=>a+c.charCodeAt(0),0) % 1000) + 1;
    const diff = Math.abs(chute - numero);
    let premio = 0, msg = '';
    if (diff === 0) { premio = 5000; msg = '🎯 **ACERTOU EXATO!** +5.000 💵!!'; }
    else if (diff <= 10) { premio = 1000; msg = `🔥 Muito perto! ±${diff}. **+1.000 💵**!`; }
    else if (diff <= 50) { premio = 300; msg = `😊 Quase lá! ±${diff}. **+300 💵**.`; }
    else if (diff <= 100) { premio = 100; msg = `😐 Razoável! ±${diff}. **+100 💵**.`; }
    else { msg = `😢 Longe! ±${diff}. O número era **${numero}**. Tente amanhã!`; }
    if (premio > 0) addAura(uid, premio);
    await interaction.reply({embeds:[new EmbedBuilder().setColor(diff===0?'#FFD700':diff<=10?'#00C851':diff<=50?'#FF9F1C':'#FF6B6B').setTitle('🔢 Número Secreto do Dia!').setDescription(`Seu chute: **${chute}**\n\n${msg}\n\n_Muda todo dia!_`).setFooter({text:'Sentinela • Número Secreto'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('pix').setDescription('💸 Transfere Moedas rapidamente (alias de /transferir)').addUserOption(o=>o.setName('usuario').setDescription('Para quem').setRequired(true)).addIntegerOption(o=>o.setName('valor').setDescription('Valor').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    const alvo = interaction.options.getUser('usuario');
    const val = interaction.options.getInteger('valor');
    if (alvo.bot||alvo.id===interaction.user.id) return interaction.reply({content:'❌ Alvo inválido!',ephemeral:true});
    const u = getUser(interaction.user.id, interaction.user.username);
    if (u.aura < val) return interaction.reply({content:`❌ Você tem apenas **${Number(u.aura).toLocaleString('pt-BR')} 💵**!`,ephemeral:true});
    removeAura(interaction.user.id, val);
    getUser(alvo.id, alvo.username);
    addAura(alvo.id, val);
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('💸 Pix enviado!').setDescription(`**${interaction.user.username}** enviou **${val.toLocaleString('pt-BR')} 💵** para ${alvo}!`).setFooter({text:'Sentinela • Pix'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('trava_lingua').setDescription('👅 Receba um trava-língua!'),
  async execute(interaction) {
    const travas = [
      'O rato roeu a roupa do rei de Roma.',
      'Três pratos de trigo para três tigres tristes.',
      'O pato pateta pateou o peito do papagaio.',
      'Fui à feira e vi figos frescos à venda.',
      'Pedro perguntou pro padre: padre, por que o padre para?',
      'Bagre, bugre, bígamo, ou bígamo bigre?',
      'Como comeu o camelo? Com calo no calcanhar!',
      'Quem tem medo de tigre não vai à África.',
    ];
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('👅 Trava-língua!').setDescription(`*"${travas[Math.floor(Math.random()*travas.length)]}"*\n\nConsegue falar 3x seguido? 😄`).setFooter({text:'Sentinela • Trava-língua'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('isso_ou_aquilo').setDescription('🤔 Isso ou aquilo? Vote!'),
  async execute(interaction) {
    const pares = [
      ['🍕 Pizza','🍔 Hambúrguer'],['🐱 Gato','🐶 Cachorro'],['☀️ Praia','🏔️ Montanha'],
      ['🎮 Videogame','🎬 Netflix'],['🌙 Noite','🌅 Manhã'],['📱 WhatsApp','💬 Discord'],
      ['🍦 Sorvete','🎂 Bolo'],['🚗 Carro','🏍️ Moto'],['🎵 Funk','🎸 Rock'],
      ['🌧️ Chuva','☀️ Sol'],['📚 Livro','🎧 Podcast'],['🏋️ Academia','🏃 Corrida'],
    ];
    const par = pares[Math.floor(Math.random()*pares.length)];
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ioa_a').setLabel(par[0]).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ioa_b').setLabel(par[1]).setStyle(ButtonStyle.Danger)
    );
    let va=0,vb=0; const votos=new Set();
    const msg = await interaction.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🤔 Isso ou Aquilo?').setDescription(`**${par[0]}** vs **${par[1]}**`).setFooter({text:'Vote! • 30s • Sentinela'})],components:[row],fetchReply:true});
    const col = msg.createMessageComponentCollector({time:30000});
    col.on('collect', async i=>{
      if(votos.has(i.user.id)) return i.reply({content:'Já votou!',ephemeral:true});
      votos.add(i.user.id); if(i.customId==='ioa_a') va++; else vb++;
      const total=va+vb;
      const pctA=total?Math.round(va/total*100):50, pctB=100-pctA;
      await i.update({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🤔 Isso ou Aquilo?').setDescription(`**${par[0]}** vs **${par[1]}**\n\n${par[0]}: **${va}** (${pctA}%) ${'█'.repeat(Math.round(pctA/10))}${'░'.repeat(10-Math.round(pctA/10))}\n${par[1]}: **${vb}** (${pctB}%) ${'█'.repeat(Math.round(pctB/10))}${'░'.repeat(10-Math.round(pctB/10))}`).setFooter({text:`${total} voto(s) • Sentinela`})],components:[row]});
    });
    col.on('end',()=>msg.edit({components:[]}).catch(()=>{}));
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('completo').setDescription('✍️ Complete a frase!'),
  async execute(interaction) {
    const frases = [
      'Se eu pudesse mudar uma coisa no mundo, eu mudaria...',
      'O melhor momento do meu dia é quando...',
      'Se eu tivesse R$ 1 milhão, eu primeiro...',
      'Meu maior arrependimento é...',
      'Se eu pudesse ter um superpoder seria...',
      'A coisa mais estranha que já comi foi...',
      'Me sinto mais eu mesmo quando...',
      'Se pudesse voltar no tempo, eu...',
    ];
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#4ECDC4').setTitle('✍️ Complete a Frase!').setDescription(frases[Math.floor(Math.random()*frases.length)]).setFooter({text:`Desafio de ${interaction.user.username} • Sentinela`})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('cotacao').setDescription('💹 Veja a cotação fictícia das Moedas do Sentinela'),
  async execute(interaction) {
    const base = 0.05;
    const variacao = (Math.random()-0.4)*0.02;
    const valor = (base + variacao).toFixed(4);
    const sinal = variacao >= 0 ? '📈 +' : '📉 ';
    await interaction.reply({embeds:[new EmbedBuilder().setColor(variacao>=0?'#00C851':'#FF6B6B').setTitle('💹 Cotação das Moedas Sentinela').addFields(
      {name:'💵 1.000 Moedas =',value:`R$ ${(parseFloat(valor)*1000).toFixed(2)}`,inline:true},
      {name:'📊 Variação hoje',value:`${sinal}${(variacao*100).toFixed(2)}%`,inline:true},
      {name:'💡 Dica',value:'Use /daily todo dia para acumular!'},
    ).setFooter({text:'Sentinela • Cotação Fictícia'}).setTimestamp()]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('role_play').setDescription('🎭 Inicia uma cena de role-play aleatória!'),
  async execute(interaction) {
    const cenas = [
      '🏴‍☠️ Você está num navio pirata no meio do Caribe. Um cofre misterioso acaba de ser trazido a bordo...',
      '🌌 Você acorda numa nave espacial que não reconhece. Os controles estão todos em inglês...',
      '🏰 Você é um cavaleiro medieval chamado para proteger o reino de uma dragão que... quer conversar?',
      '🤠 É o Velho Oeste. Você entra num saloon e todos param de falar. Alguém reconhece seu rosto...',
      '🧙 Você é um aprendiz de feiticeiro que acidentalmente trocou o professor por um sapo.',
      '🔍 Você é um detetive particular. Alguém bateu na sua porta às 3 da manhã com uma caixa lacrada.',
      '🚀 Você é o primeiro humano em Marte. Mas achou uma porta na rocha.',
    ];
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#7B2FBE').setTitle('🎭 Role-Play!').setDescription(cenas[Math.floor(Math.random()*cenas.length)]).setFooter({text:`Narrado para ${interaction.user.username} • Sentinela`})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('ascii').setDescription('🎨 Gera arte ASCII temática'),
  async execute(interaction) {
    const artes = [
      '```\n  /\_/\  \n ( o.o ) \n  > ^ <\n```\nO Sentinela está de plantão! 🤠',
      '```\n  __  \n /  \ \n|    |\n \__/ \n```\nMoeda! 💵',
      '```\n★ ★ ★\n Sentinela ★\n★ ★ ★\n```\nBrilhando! ✨',
      '```\n  _____\n |     |\n | GUN |\n |_____|\n```\nCowboy mode 🤠',
    ];
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#4ECDC4').setTitle('🎨 Arte ASCII').setDescription(artes[Math.floor(Math.random()*artes.length)]).setFooter({text:'Sentinela • ASCII Art'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('batalha').setDescription('⚔️ Batalha épica contra um monstro!'),
  async execute(interaction) {
    const monstros = [
      {nome:'Goblin',hp:30,atk:[5,15],emoji:'👺',recompensa:[50,150]},
      {nome:'Dragão Bebê',hp:60,atk:[10,25],emoji:'🐲',recompensa:[100,300]},
      {nome:'Lobisomem',hp:80,atk:[15,35],emoji:'🐺',recompensa:[150,400]},
      {nome:'Vampiro',hp:100,atk:[20,40],emoji:'🧛',recompensa:[200,600]},
      {nome:'Dragão Ancião',hp:200,atk:[30,60],emoji:'🐉',recompensa:[500,1500]},
    ];
    const m = monstros[Math.floor(Math.random()*monstros.length)];
    const u = getUser(interaction.user.id, interaction.user.username);
    let hpJogador = 100 + u.nivel * 10;
    let hpMonstro = m.hp;
    let turnos = 0, log = [];
    while (hpJogador > 0 && hpMonstro > 0 && turnos < 20) {
      const danoJogador = Math.floor(Math.random()*20)+10+u.nivel*2;
      const danoMonstro = Math.floor(Math.random()*(m.atk[1]-m.atk[0]))+m.atk[0];
      hpMonstro -= danoJogador; hpJogador -= danoMonstro; turnos++;
      if (turnos <= 3) log.push(`⚔️ Você causou **${danoJogador}** dmg | ${m.emoji} causou **${danoMonstro}** dmg`);
    }
    const venceu = hpJogador > 0;
    const premio = venceu ? Math.floor(Math.random()*(m.recompensa[1]-m.recompensa[0]))+m.recompensa[0] : 0;
    if (venceu) { addAura(interaction.user.id, premio); addXP(interaction.user.id, m.hp); }
    await interaction.reply({embeds:[new EmbedBuilder().setColor(venceu?'#00C851':'#FF6B6B').setTitle(`${venceu?'🏆 Vitória!':'💀 Derrota!'} vs ${m.nome} ${m.emoji}`).setDescription(log.join('\n')+`\n\n**${turnos} turnos**\n${venceu?`+${premio.toLocaleString('pt-BR')} 💵 +${m.hp} XP`:'Você foi derrotado...'}`).setFooter({text:'Sentinela • Batalha'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('dungeon').setDescription('🏰 Explore uma dungeon e encontre tesouros (ou armadilhas)!'),
  async execute(interaction) {
    const salas = [
      {desc:'Você encontrou um baú brilhante!',emoji:'💰',tipo:'tesouro',valor:500},
      {desc:'Uma armadilha! Flechas voam na sua direção!',emoji:'🏹',tipo:'armadilha',valor:-300},
      {desc:'Você achou um portal mágico e voltou com os bolsos cheios!',emoji:'🌀',tipo:'tesouro',valor:800},
      {desc:'Um fantasma te assustou — você largou as moedas!',emoji:'👻',tipo:'armadilha',valor:-200},
      {desc:'Você encontrou o covil do dragão... e seu tesouro!',emoji:'🐉',tipo:'tesouro',valor:1200},
      {desc:'Nada aqui além de poeira e decepção.',emoji:'🌫️',tipo:'nada',valor:0},
      {desc:'Um gnomo amigável te deu uma gorjeta!',emoji:'🧙',tipo:'tesouro',valor:350},
      {desc:'Você caiu numa armadilha de areia movediça!',emoji:'⏳',tipo:'armadilha',valor:-400},
    ];
    const sala = salas[Math.floor(Math.random()*salas.length)];
    const u = getUser(interaction.user.id, interaction.user.username);
    if (sala.valor > 0) addAura(interaction.user.id, sala.valor);
    else if (sala.valor < 0) removeAura(interaction.user.id, Math.abs(sala.valor));
    const cor = sala.tipo==='tesouro'?'#FFD700':sala.tipo==='armadilha'?'#FF6B6B':'#808080';
    const resultado = sala.valor>0?`**+${sala.valor.toLocaleString('pt-BR')} 💵**`:sala.valor<0?`**-${Math.abs(sala.valor).toLocaleString('pt-BR')} 💵**`:'Nada ganhou, nada perdeu.';
    await interaction.reply({embeds:[new EmbedBuilder().setColor(cor).setTitle(`${sala.emoji} Dungeon — ${sala.tipo==='tesouro'?'Tesouro!':sala.tipo==='armadilha'?'Armadilha!':'Sala vazia'}`).setDescription(`${sala.desc}\n\n${resultado}`).setFooter({text:'Sentinela • Dungeon • CD: use /trabalho_info'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('investir').setDescription('📈 Invista suas Moedas na bolsa fictícia!').addIntegerOption(o=>o.setName('valor').setDescription('Quanto investir').setRequired(true).setMinValue(100)),
  async execute(interaction) {
    const val = interaction.options.getInteger('valor');
    const u = getUser(interaction.user.id, interaction.user.username);
    if (u.aura < val) return interaction.reply({content:`❌ Você tem apenas **${Number(u.aura).toLocaleString('pt-BR')} 💵**!`,ephemeral:true});
    const resultado = Math.random();
    let multiplicador, descricao, cor;
    if (resultado < 0.05) { multiplicador = 5; descricao = '🚀 **MOONSHOT!** Você acertou o investimento da vida!'; cor = '#FFD700'; }
    else if (resultado < 0.25) { multiplicador = 2; descricao = '📈 Ótimo retorno! Mercado em alta!'; cor = '#00C851'; }
    else if (resultado < 0.55) { multiplicador = 1.3; descricao = '📊 Lucro moderado. Mercado estável.'; cor = '#7B2FBE'; }
    else if (resultado < 0.75) { multiplicador = 0.8; descricao = '📉 Pequena perda. Mercado oscilou.'; cor = '#FF9F1C'; }
    else { multiplicador = 0.4; descricao = '💥 Crash! O mercado despencou!'; cor = '#FF0000'; }
    const retorno = Math.floor(val * multiplicador);
    const diff = retorno - val;
    removeAura(interaction.user.id, val);
    addAura(interaction.user.id, retorno);
    await interaction.reply({embeds:[new EmbedBuilder().setColor(cor).setTitle('📈 Resultado do Investimento').setDescription(descricao).addFields(
      {name:'💵 Investido',value:val.toLocaleString('pt-BR'),inline:true},
      {name:'💰 Retorno',value:retorno.toLocaleString('pt-BR'),inline:true},
      {name:diff>=0?'📈 Lucro':'📉 Prejuízo',value:`${diff>=0?'+':''}${diff.toLocaleString('pt-BR')} 💵`,inline:true},
    ).setFooter({text:'Sentinela • Bolsa Fictícia'})]});
  },
});

commands.push({
  data: new SlashCommandBuilder().setName('banco').setDescription('🏦 Gerencie sua conta bancária').addStringOption(o=>o.setName('acao').setDescription('Ação').setRequired(true).addChoices({name:'💰 Depositar',value:'depositar'},{name:'💸 Sacar',value:'sacar'},{name:'📊 Saldo',value:'saldo'})).addIntegerOption(o=>o.setName('valor').setDescription('Valor (para depositar/sacar)').setRequired(false).setMinValue(1)),
  async execute(interaction) {
    const acao = interaction.options.getString('acao');
    const val = interaction.options.getInteger('valor');
    const uid = interaction.user.id;
    getUser(uid, interaction.user.username);
    // Banco como inventário especial
    const bancoItem = dbGet('SELECT * FROM inventario WHERE user_id = ? AND item = ?',[uid,'_banco']);
    const saldoBanco = bancoItem ? parseInt(bancoItem.quantidade) : 0;
    if (acao === 'saldo') {
      const u = getUser(uid);
      return interaction.reply({embeds:[new EmbedBuilder().setColor('#4ECDC4').setTitle('🏦 Seu Banco').addFields({name:'👛 Carteira',value:`${Number(u.aura).toLocaleString('pt-BR')} 💵`,inline:true},{name:'🏦 Banco',value:`${saldoBanco.toLocaleString('pt-BR')} 💵`,inline:true},{name:'💰 Total',value:`${(Number(u.aura)+saldoBanco).toLocaleString('pt-BR')} 💵`,inline:true}).setFooter({text:'Sentinela • Banco'})]});
    }
    if (!val) return interaction.reply({content:'❌ Informe o valor!',ephemeral:true});
    if (acao === 'depositar') {
      const u = getUser(uid); if(u.aura<val) return interaction.reply({content:'❌ Saldo insuficiente!',ephemeral:true});
      removeAura(uid, val);
      if (bancoItem) dbRun('UPDATE inventario SET quantidade = quantidade + ? WHERE user_id = ? AND item = ?',[val,uid,'_banco']);
      else dbRun('INSERT INTO inventario (user_id, item, quantidade) VALUES (?,?,?)',[uid,'_banco',val]);
      return interaction.reply({embeds:[new EmbedBuilder().setColor('#00C851').setTitle('🏦 Depósito realizado!').setDescription(`**+${val.toLocaleString('pt-BR')} 💵** depositados no banco!\n🏦 Saldo banco: **${(saldoBanco+val).toLocaleString('pt-BR')} 💵**`).setFooter({text:'Sentinela • Banco'})]});
    }
    if (acao === 'sacar') {
      if(saldoBanco<val) return interaction.reply({content:'❌ Saldo bancário insuficiente!',ephemeral:true});
      addAura(uid, val);
      dbRun('UPDATE inventario SET quantidade = quantidade - ? WHERE user_id = ? AND item = ?',[val,uid,'_banco']);
      return interaction.reply({embeds:[new EmbedBuilder().setColor('#FF9F1C').setTitle('🏦 Saque realizado!').setDescription(`**${val.toLocaleString('pt-BR')} 💵** sacados do banco!\n🏦 Saldo banco: **${(saldoBanco-val).toLocaleString('pt-BR')} 💵**`).setFooter({text:'Sentinela • Banco'})]});
    }
  },
});

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
// SERVIDOR HTTP — HEALTH CHECK (UptimeRobot)
// ─────────────────────────────────────────────────────────────
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  const status = client.isReady() ? 'online' : 'starting';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status, bot: client.user?.tag ?? null, uptime: process.uptime(), guilds: client.guilds.cache.size }));
}).listen(PORT, () => console.log(`🌐 Health server na porta ${PORT}`));

// Inicia o banco e depois o bot
initDb().then(() => {
  console.log('✅ Banco de dados carregado!');
  client.login(process.env.DISCORD_TOKEN);
}).catch(err => {
  console.error('❌ Erro ao iniciar banco:', err);
  process.exit(1);
});
