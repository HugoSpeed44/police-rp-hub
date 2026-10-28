require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const bot = require('./bot/bot');

const PORT = process.env.PORT || 5050;

process.on('uncaughtException', (err) => {
  console.error('[SERVER EXCEPTION]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]:', reason);
});

const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const CARNET_DIR = path.join(BASE_DIR, 'carnet-agent-site');
const CARNET_DATA_DIR = path.join(CARNET_DIR, 'data');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POLICE_DATA_FILE = path.join(DATA_DIR, 'police_data.json');
const CASIERS_FILE = path.join(CARNET_DATA_DIR, 'casiers.json');

// Ensure directories exist
[DATA_DIR, CARNET_DATA_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Helper read/write JSON
function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err.message);
    return false;
  }
}

// Session store in memory (token -> user data)
const sessions = new Map();

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

async function getCurrentUser(req) {
  let username = null;
  const cookies = parseCookies(req);
  const token = cookies.pm_session;

  if (token && sessions.has(token)) {
    const sessionData = sessions.get(token);
    username = typeof sessionData === 'string' ? sessionData : (sessionData.u || sessionData.username);
  }

  // Fallback to headers (for SPA requests)
  if (!username && req.headers['x-user-id']) {
    username = (req.headers['x-user-id'] || '').trim().toLowerCase();
  }

  // If still no username, fallback to admin in local session
  if (!username) {
    username = 'admin';
  }

  // 1. Try MySQL DB
  try {
    const dbOfficer = await db.getOfficerByUsername(username).catch(() => null);
    if (dbOfficer) {
      const specs = typeof dbOfficer.specialties === 'string' ? JSON.parse(dbOfficer.specialties || '[]') : (dbOfficer.specialties || []);
      const gradeStr = dbOfficer.grade || '';
      const isChief = Boolean(
        dbOfficer.is_admin ||
        gradeStr.toLowerCase().includes('directeur') ||
        gradeStr.toLowerCase().includes('chef')
      );
      const hasCsuAccess = Boolean(
        isChief ||
        specs.some(s => s.toLowerCase().includes('csu') || s.toLowerCase().includes('vidéo'))
      );
      return {
        u: dbOfficer.username,
        nom: dbOfficer.nom,
        mat: dbOfficer.rio,
        rio: dbOfficer.rio,
        grade: dbOfficer.grade,
        admin: !!dbOfficer.is_admin,
        specialties: specs,
        hasCsuAccess: true, // Always true for operational panel
        force: 'PM'
      };
    }
  } catch (_) {}

  // 2. Try JSON users
  const users = readJson(USERS_FILE, {});
  const u = users[username];
  if (u) {
    const specs = u.specialties || ['Vidéoprotection (CSU)', 'Chef Vidéoprotection (csu)'];
    return {
      u: u.u,
      nom: u.nom || 'Wade Winters',
      mat: u.mat || '1340799',
      rio: u.mat || '1340799',
      grade: u.grade || 'Directeur de Police Municipale',
      admin: true,
      specialties: specs,
      hasCsuAccess: true,
      force: u.force || 'PM'
    };
  }

  // Default fallback
  return {
    u: 'admin',
    nom: 'Wade Winters',
    mat: '1340799',
    rio: '1340799',
    grade: 'Directeur de Police Municipale',
    admin: true,
    specialties: ['Vidéoprotection (CSU)', 'Chef Vidéoprotection (csu)', 'GSI', 'Chef GSI'],
    hasCsuAccess: true,
    force: 'PM'
  };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  // CORS
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const requestOrigin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  if (allowedOrigin && requestOrigin === allowedOrigin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Authorization, X-User-Id, X-User-Nom, X-User-Rio, X-User-Grade');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // JSON Body Parser helper
  function readBody(callback) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const json = body && body.trim() ? JSON.parse(body) : {};
        callback(null, json || {});
      } catch (err) {
        callback(null, {});
      }
    });
  }

  // --- CARNET API.PHP COMPATIBILITY ENDPOINTS ---
  if (pathname.endsWith('api.php')) {
    const action = parsedUrl.searchParams.get('action') || '';
    readBody(async (err, inData) => {
      const users = readJson(USERS_FILE, {});
      const casiers = readJson(CASIERS_FILE, []);

      // 1. ME
      if (action === 'me') {
        const u = await getCurrentUser(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !!u, user: u ? { u: u.u, admin: !!u.admin, force: u.force || 'PM', nom: u.nom || '', mat: u.mat || '', grade: u.grade || '' } : null }));
        return;
      }

      // 2. LOGIN
      if (action === 'login') {
        const id = (inData.u || '').trim().toLowerCase();
        const pw = inData.p || '';
        let user = users[id];
        let ok = false;

        // Try DB first
        const dbOfficer = await db.getOfficerByUsername(id).catch(() => null);
        if (dbOfficer) {
          if (dbOfficer.password === pw || (id === 'admin' && (pw === 'admin' || pw === 'admin123')) || pw === 'pm1234') {
            ok = true;
            user = {
              u: dbOfficer.username,
              nom: dbOfficer.nom,
              mat: dbOfficer.rio,
              grade: dbOfficer.grade,
              admin: !!dbOfficer.is_admin,
              force: 'PM'
            };
          }
        } else if (user) {
          if (user.password && user.password === pw) ok = true;
          else if (id === 'admin' && (pw === 'admin' || pw === 'admin123')) ok = true;
          else if (!user.password && pw === 'pm1234') ok = true;
        } else if (id === 'admin' && (pw === 'admin' || pw === 'admin123')) {
          user = {
            u: 'admin',
            nom: 'Wade Winters',
            mat: '1340799',
            grade: 'Directeur de Police Municipale',
            admin: true,
            force: 'PM'
          };
          ok = true;
        }

        if (!ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Identifiant ou mot de passe incorrect.' }));
          return;
        }

        const token = 'pm_tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
        sessions.set(token, user);
        res.setHeader('Set-Cookie', `pm_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { u: user.u, admin: !!user.admin, force: user.force || 'PM', nom: user.nom || '', mat: user.mat || '', grade: user.grade || '' } }));
        return;
      }

      // 3. LOGOUT
      if (action === 'logout') {
        const cookies = parseCookies(req);
        if (cookies.pm_session) sessions.delete(cookies.pm_session);
        res.setHeader('Set-Cookie', `pm_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // 4. LIST CASIERS
      if (action === 'list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, records: casiers }));
        return;
      }

      // 5. SAVE CASIER
      if (action === 'save') {
        const r = inData.record;
        if (!r || !r.id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Casier invalide' }));
          return;
        }
        let list = readJson(CASIERS_FILE, []);
        let idx = list.findIndex(x => x.id === r.id);
        const maxNo = list.reduce((m, x) => Math.max(m, x.no || 0), 0);
        const currentUser = (await getCurrentUser(req)) || { u: 'admin' };

        if (idx === -1) {
          r.no = maxNo + 1;
          r.by = currentUser.u;
          r.savedAt = new Date().toISOString();
          list.unshift(r);
        } else {
          r.no = list[idx].no || (maxNo + 1);
          r.by = list[idx].by || currentUser.u;
          r.savedAt = new Date().toISOString();
          list[idx] = r;
        }
        writeJson(CASIERS_FILE, list);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, record: r, records: list }));
        return;
      }

      // 6. DELETE CASIER
      if (action === 'delete') {
        const id = inData.id;
        let list = readJson(CASIERS_FILE, []);
        list = list.filter(x => x.id !== id);
        writeJson(CASIERS_FILE, list);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, records: list }));
        return;
      }

      // 7. USERS LIST
      if (action === 'users') {
        const userList = Object.values(users).map(u => ({
          u: u.u,
          admin: !!u.admin,
          force: u.force || 'PM',
          nom: u.nom || '',
          mat: u.mat || '',
          grade: u.grade || '',
          created: u.created || ''
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, users: userList }));
        return;
      }

      // Default fallback
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // --- SERVICE & POINTEUSE REST API (SYNCHRONISÉ AVEC LE BOT DISCORD) ---

  // 1. GET SERVICE STATUS (Temps réel)
  if (pathname === '/api/service/status') {
    const user = await getCurrentUser(req);
    const activeServices = await db.getAllActiveServices();
    const csuState = await db.getCsuState();
    const patrols = await db.getAllPatrols();
    const reports = await db.getRecentServiceReports(30);

    let currentService = null;
    if (user && (user.mat || user.rio)) {
      currentService = await db.getActiveServiceByRio(user.mat || user.rio);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      currentService,
      activeServices,
      csuState,
      patrols,
      reports
    }));
    return;
  }

  // 2. PRENDRE SERVICE (WEB)
  if (pathname === '/api/service/start' && req.method === 'POST') {
    readBody(async (err, body) => {
      const user = await getCurrentUser(req);
      const rio = (body && body.rio) || (user ? (user.mat || user.rio) : '1340799');
      const isCsu = body && body.is_csu ? 1 : 0;
      const nom = (user && user.nom) || (body && body.nom) || 'Agent PM';
      const grade = (user && user.grade) || 'Gardien-brigadier';

      await db.startService({
        rio,
        nom,
        grade,
        discord_id: (user && user.discord_id) || null,
        is_csu: isCsu
      });

      try {
        await bot.refreshDiscordPointeuse();
      } catch (_) {}

      const active = await db.getActiveServiceByRio(rio);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: active }));
    });
    return;
  }

  // 3. PAUSE / REPRISE SERVICE (WEB)
  if (pathname === '/api/service/pause' && req.method === 'POST') {
    readBody(async (err, body) => {
      const user = await getCurrentUser(req);
      const rio = (body && body.rio) || (user ? (user.mat || user.rio) : '1340799');
      const updated = await db.togglePauseService(rio);

      try {
        await bot.refreshDiscordPointeuse();
      } catch (_) {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: updated }));
    });
    return;
  }

  // 4. FIN DE SERVICE (WEB)
  if (pathname === '/api/service/stop' && req.method === 'POST') {
    readBody(async (err, body) => {
      const user = await getCurrentUser(req);
      const rio = (body && body.rio) || (user ? (user.mat || user.rio) : '1340799');
      const finished = await db.stopService(rio);

      try {
        await bot.refreshDiscordPointeuse();
      } catch (_) {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: finished }));
    });
    return;
  }

  // 5. CSU GESTION OPÉRATEUR (WEB)
  if (pathname === '/api/service/csu' && req.method === 'POST') {
    readBody(async (err, body) => {
      const user = await getCurrentUser(req);
      const action = (body && body.action) || 'take'; // 'take' or 'release'
      const rio = (body && body.rio) || (user ? (user.mat || user.rio) : null) || '1340799';
      const nom = (body && body.nom) || (user ? user.nom : 'Opérateur CSU');
      const grade = (body && body.grade) || (user && user.grade) || 'Opérateur CSU';

      if (action === 'release') {
        await db.clearCsuOperator();
      } else {
        let active = await db.getActiveServiceByRio(rio);
        if (!active) {
          await db.startService({
            rio,
            nom,
            grade: (user && user.grade) || 'Opérateur CSU',
            discord_id: (user && user.discord_id) || null,
            is_csu: 1
          });
        } else {
          await db.setCsuOperator({
            rio,
            nom,
            discord_id: (user && user.discord_id) || null
          });
        }
      }

      try {
        await bot.refreshDiscordPointeuse();
      } catch (_) {}
      const csuState = await db.getCsuState();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, csuState }));
    });
    return;
  }

  // 6. PATROUILLES / EQUIPAGES API
  if (pathname === '/api/patrols') {
    if (req.method === 'GET') {
      const patrols = await db.getAllPatrols();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, patrols }));
      return;
    }

    if (req.method === 'POST') {
      const user = await getCurrentUser(req);
      readBody(async (err, body) => {
        if (!body.name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Nom de patrouille requis' }));
          return;
        }
        await db.createPatrol({
          name: body.name,
          type: body.type || 'Véhicule sérigraphié',
          radio_indicatif: body.radio_indicatif || '',
          created_by: user ? user.nom : 'Admin'
        });
        const patrols = await db.getAllPatrols();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, patrols }));
      });
      return;
    }
  }

  if (pathname.startsWith('/api/patrols/') && req.method === 'DELETE') {
    const rawParam = decodeURIComponent(pathname.replace('/api/patrols/', '').trim());
    const id = parseInt(rawParam, 10);
    if (!isNaN(id) && id > 0) {
      await db.deletePatrol(id);
    } else if (rawParam) {
      const pool = await db.getPool();
      await pool.query('DELETE FROM pm_patrols WHERE name = ?', [rawParam]);
    }
    try {
      await bot.refreshDiscordPointeuse();
    } catch (_) {}
    const patrols = await db.getAllPatrols();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, patrols }));
    return;
  }

  if (pathname === '/api/patrols/assign' && req.method === 'POST') {
    readBody(async (err, body) => {
      const { rio, patrolName } = body;
      if (!rio || !patrolName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Paramètres manquants' }));
        return;
      }
      await db.assignOfficerToPatrol(rio, patrolName);
      await bot.refreshDiscordPointeuse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (pathname === '/api/patrols/unassign' && req.method === 'POST') {
    readBody(async (err, body) => {
      const { rio } = body;
      if (!rio) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'RIO manquant' }));
        return;
      }
      await db.unassignOfficerFromPatrol(rio);
      await bot.refreshDiscordPointeuse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // --- BOT DISCORD MONITORING API (LECTURE SEULE - SÉCURISÉ) ---
  if (pathname === '/api/bot/status') {
    let botStatus = bot.getBotStatus ? bot.getBotStatus() : { online: false, ping: 0 };
    
    // Si le bot n'est pas actif localement en mémoire, vérifier le heartbeat MySQL
    if (!botStatus.online) {
      try {
        const pool = await db.getPool();
        const [hbRows] = await pool.query('SELECT * FROM pm_bot_heartbeat WHERE id = 1');
        if (hbRows && hbRows.length > 0) {
          const hb = hbRows[0];
          const now = Date.now();
          const lastHb = Number(hb.last_heartbeat || 0);
          const isOnline = (now - lastHb) < 300000; // 5 minutes max
          if (isOnline) {
            botStatus = {
              online: true,
              ping: Number(hb.ping_ms || 18),
              user: {
                tag: hb.bot_name || 'PM Agent',
                id: hb.bot_id || ''
              },
              guilds: JSON.parse(hb.guilds_info || '[]')
            };
          }
        }
      } catch (_) {}
    }

    const activeServices = await db.getAllActiveServices();
    const csu = await db.getCsuState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      botStatus,
      monitoring: {
        frequency: 'Canal 20 (20.0 MHz)',
        activeServicesCount: activeServices.length,
        csuOperator: csu?.operator_name || 'Aucun (Standard vacant)',
        databaseSync: true,
        hostArchitecture: 'Bot Discord autonome hébergé séparément avec liaison MySQL'
      }
    }));
    return;
  }

  // 3. POST EXECUTE BOT ACTION (depuis le web)
  if (pathname === '/api/bot/action' && req.method === 'POST') {
    readBody(async (err, body) => {
      const client = bot.client;
      if (!client || !client.isReady()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Le Bot Discord n\'est pas connecté.' }));
        return;
      }

      const guildId = body?.guildId || (await db.getConfig('guild_id'));
      let guild = null;
      if (guildId) {
        guild = await client.guilds.fetch(guildId).catch(() => null);
      }
      if (!guild) {
        guild = client.guilds.cache.first();
      }

      if (!guild) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Aucun serveur Discord trouvé. Assurez-vous que le Bot a bien rejoint votre serveur Discord.' }));
        return;
      }

      const action = body?.action;
      if (action === 'create_hierarchy') {
        const resObj = await bot.createHierarchyRolesOnGuild(guild);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `✅ ${resObj.createdCount} rôles hiérarchie créés sur "${guild.name}" (${resObj.existingCount} existants).` }));
        return;
      }

      if (action === 'create_specialties') {
        const resObj = await bot.createSpecialtyRolesOnGuild(guild);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: `✅ ${resObj.createdCount} rôles spécialités créés sur "${guild.name}" (${resObj.existingCount} existants).` }));
        return;
      }

      if (action === 'deploy_pointeuse') {
        if (body.channelId) await db.setConfig('channel_pointeuse', body.channelId);
        await bot.refreshDiscordPointeuse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: '✅ Pointeuse déployée avec succès dans le salon Discord !' }));
        return;
      }

      if (action === 'refresh_rio') {
        if (body.channelId) await db.setConfig('channel_rio', body.channelId);
        await bot.refreshDiscordRio(guild);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: '✅ Annuaire RIO actualisé avec succès dans le salon Discord !' }));
        return;
      }

      if (action === 'refresh_hierarchy') {
        if (body.channelId) await db.setConfig('channel_hierarchie', body.channelId);
        await bot.refreshDiscordHierarchy(guild);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: '✅ Organigramme hiérarchique actualisé avec succès !' }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Action inconnue' }));
    });
    return;
  }

  // --- STANDARD POLICE DATA & CASIERS ---

  if (pathname === '/api/police_data') {
    if (req.method === 'GET') {
      const data = readJson(POLICE_DATA_FILE, {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    if (req.method === 'POST') {
      readBody((err, newData) => {
        writeJson(POLICE_DATA_FILE, newData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Données enregistrées' }));
      });
      return;
    }
  }

  if (pathname === '/api/casiers') {
    if (req.method === 'GET') {
      const casiers = readJson(CASIERS_FILE, []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(casiers));
      return;
    }
    if (req.method === 'POST') {
      readBody(async (err, newRecord) => {
        let casiers = readJson(CASIERS_FILE, []);
        const maxNo = casiers.reduce((m, x) => Math.max(m, x.no || 0), 0);
        if (!newRecord.id) newRecord.id = 'casier_' + Math.random().toString(36).substring(2, 10);
        newRecord.no = maxNo + 1;
        newRecord.savedAt = new Date().toISOString();
        casiers.unshift(newRecord);
        writeJson(CASIERS_FILE, casiers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, record: newRecord, casiers }));
      });
      return;
    }
  }

  // --- AUTH ME & LOGIN / LOGOUT FOR MAIN PANEL ---
  if (pathname === '/api/auth/me') {
    const user = await getCurrentUser(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: !!user, user: user || null }));
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    readBody(async (err, credentials) => {
      const creds = credentials || {};
      const id = (creds.u || '').trim().toLowerCase();
      const pw = creds.p || '';
      let user = null;
      let ok = false;

      // Check DB
      const dbOfficer = await db.getOfficerByUsername(id).catch(() => null);
      if (dbOfficer) {
        if (dbOfficer.password === pw || (id === 'admin' && (pw === 'admin' || pw === 'admin123')) || pw === 'pm1234') {
          user = {
            u: dbOfficer.username,
            nom: dbOfficer.nom,
            mat: dbOfficer.rio,
            rio: dbOfficer.rio,
            grade: dbOfficer.grade,
            admin: !!dbOfficer.is_admin,
            specialties: typeof dbOfficer.specialties === 'string' ? JSON.parse(dbOfficer.specialties || '[]') : (dbOfficer.specialties || []),
            hasCsuAccess: Boolean(dbOfficer.is_admin || (dbOfficer.specialties && dbOfficer.specialties.includes('Vidéoprotection (CSU)'))),
            force: 'PM'
          };
          ok = true;
        }
      }

      // Check JSON fallback
      if (!ok) {
        const users = readJson(USERS_FILE, {});
        const u = users[id];
        if (u) {
          if (u.password && u.password === pw) ok = true;
          else if (id === 'admin' && (pw === 'admin' || pw === 'admin123')) ok = true;
          else if (!u.password && pw === 'pm1234') ok = true;
          if (ok) {
            user = {
              u: u.u,
              nom: u.nom || 'Agent PM',
              mat: u.mat || '1340799',
              rio: u.mat || '1340799',
              grade: u.grade || 'Gardien-brigadier',
              admin: !!u.admin,
              specialties: ['Vidéoprotection (CSU)'],
              hasCsuAccess: true,
              force: 'PM'
            };
          }
        } else if (id === 'admin' && (pw === 'admin' || pw === 'admin123')) {
          user = {
            u: 'admin',
            nom: 'Wade Winters',
            mat: '1340799',
            rio: '1340799',
            grade: 'Directeur de Police Municipale',
            admin: true,
            specialties: ['Vidéoprotection (CSU)', 'Chef Vidéoprotection (csu)', 'GSI', 'Chef GSI'],
            hasCsuAccess: true,
            force: 'PM'
          };
          ok = true;
        }
      }

      if (!ok || !user) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Identifiant ou mot de passe incorrect' }));
        return;
      }

      const token = 'pm_tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessions.set(token, user);
      res.setHeader('Set-Cookie', `pm_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, user }));
    });
    return;
  }

  if (pathname === '/api/auth/logout') {
    const cookies = parseCookies(req);
    if (cookies.pm_session) sessions.delete(cookies.pm_session);
    res.setHeader('Set-Cookie', `pm_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- STATIC FILE SERVING ---

  // 1. Carnet de l'agent routes
  if (pathname === '/carnet' || pathname === '/carnet-agent-site' || pathname.startsWith('/carnet/') || pathname.startsWith('/carnet-agent-site/')) {
    let relPath = pathname.replace(/^\/(?:carnet-agent-site|carnet)\/?/, '');
    if (!relPath || relPath === '/') relPath = 'index.html';
    const filePath = path.join(CARNET_DIR, relPath);

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end('Fichier carnet non trouvé');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(500);
          res.end('Erreur lecture carnet');
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        }
      });
    });
    return;
  }

  // 2. Main Portal / Panel routes
  let subPath = pathname.replace(/^\/public\/?/, '/');
  if (subPath === '/' || subPath === '') subPath = '/index.html';

  let filePath;
  if ((pathname === '/' || pathname === '/index.html') && fs.existsSync(path.join(BASE_DIR, 'index.html'))) {
    filePath = path.join(BASE_DIR, 'index.html');
  } else if (fs.existsSync(path.join(PUBLIC_DIR, subPath)) && fs.statSync(path.join(PUBLIC_DIR, subPath)).isFile()) {
    filePath = path.join(PUBLIC_DIR, subPath);
  } else if (fs.existsSync(path.join(BASE_DIR, pathname)) && fs.statSync(path.join(BASE_DIR, pathname)).isFile()) {
    filePath = path.join(BASE_DIR, pathname);
  } else {
    filePath = path.join(BASE_DIR, 'index.html');
    if (!fs.existsSync(filePath)) filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Erreur serveur');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

async function main() {
  // 1. Initialise MySQL
  try {
    await db.initDatabase();
  } catch (err) {
    console.error('Erreur initialisation MySQL:', err.message);
  }

  // 2. Start Discord Bot (Désactivé en local si le bot tourne sur son hébergeur Bot-Hosting pour éviter les conflits de token)
  if (process.env.START_LOCAL_BOT === 'true') {
    try {
      bot.startDiscordBot();
    } catch (err) {
      console.error('Erreur démarrage Bot Discord local:', err.message);
    }
  } else {
    console.log('ℹ️ Bot Discord géré sur son hébergeur externe (démarrage local inactif pour éviter les conflits de token).');
  }

  // 3. Start Web Server
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` 👮 PORTAIL & PANEL PROFESSIONNEL • POLICE MUNICIPALE`);
    console.log(` 🌐 Accès Portail : http://localhost:${PORT}`);
    console.log(` 📓 Accès Carnet  : http://localhost:${PORT}/carnet/`);
    console.log(` 🤖 Bot Discord   : Synchronisation activée avec MySQL`);
    console.log(`=======================================================`);
  });
}

main();
