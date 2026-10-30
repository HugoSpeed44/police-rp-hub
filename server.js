require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const db = require('./db');

const PORT = Number(process.env.PORT || 10000);
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const allowedOriginSetting = String(process.env.ALLOWED_ORIGIN || '').trim();
const allowedOrigin = allowedOriginSetting ? new URL(allowedOriginSetting).origin : '';

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJson(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > maxBytes) reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 }));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('JSON invalide'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function getSession(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(match[1]);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session.user;
}

function normalizeOfficer(officer) {
  let specialties = officer.specialties || [];
  if (typeof specialties === 'string') {
    try { specialties = JSON.parse(specialties || '[]'); } catch { specialties = []; }
  }
  return {
    u: officer.username,
    discord_id: officer.discord_id || null,
    nom: officer.nom,
    mat: officer.rio,
    rio: officer.rio,
    grade: officer.grade,
    admin: Boolean(officer.is_admin),
    specialties: Array.isArray(specialties) ? specialties : [],
    hasCsuAccess: Boolean(officer.is_admin || specialties.some(x => String(x).toLowerCase().includes('csu'))),
    profileCompleted: Boolean(officer.profile_completed),
    force: 'PM'
  };
}

function canManageHr(user) {
  const grade = String(user?.grade || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return ['directeur principal', 'directeur adjoint', 'directeur de police municipale'].includes(grade);
}

function canDeleteSiteAccounts(user) {
  return Boolean(user?.admin && String(user.u || '').trim().toLowerCase() === 'admin');
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

async function verifyPortalPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return stored === password;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, expected.length, (err, result) => err ? reject(err) : resolve(result));
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (allowedOrigin && origin && origin !== allowedOrigin) {
    return send(res, 403, { ok: false, error: 'Origine non autorisée' });
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-User-Id, X-User-Rio, X-User-Nom, X-User-Grade');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  try {
    if (path === '/' || path === '/health') return send(res, 200, { ok: true, service: 'police-rp-api' });

    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const username = String(body.u || '').trim();
      const password = String(body.p || '');
      if (!username || !password) return send(res, 400, { ok: false, error: 'Identifiant et mot de passe requis' });
      const officer = await db.getOfficerByUsername(username);
      if (!officer || !officer.website_access || !await verifyPortalPassword(password, officer.password)) {
        return send(res, 401, { ok: false, error: 'Identifiant ou mot de passe incorrect' });
      }
      const user = normalizeOfficer(officer);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
      return send(res, 200, { ok: true, token, user });
    }

    const user = getSession(req);
    if (path === '/api/auth/me' && req.method === 'GET') {
      if (!user) return send(res, 200, { loggedIn: false, user: null });
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
      const officer = await db.getOfficerByUsername(user.u);
      if (!officer || !officer.website_access) {
        if (token) sessions.delete(token);
        return send(res, 200, { loggedIn: false, user: null });
      }
      const updatedUser = normalizeOfficer(officer);
      if (token && sessions.has(token)) sessions.get(token).user = updatedUser;
      return send(res, 200, { loggedIn: true, user: updatedUser });
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (match) sessions.delete(match[1]);
      return send(res, 200, { ok: true });
    }
    if (!user) return send(res, 401, { ok: false, error: 'Session expirée, reconnectez-vous.' });

    if (path === '/api/auth/profile' && req.method === 'POST') {
      const body = await readJson(req);
      const firstName = String(body.firstName || '').trim().replace(/\s+/g, ' ');
      const lastName = String(body.lastName || '').trim().replace(/\s+/g, ' ');
      if (firstName.length < 2 || firstName.length > 64 || lastName.length < 2 || lastName.length > 64) {
        return send(res, 400, { ok: false, error: 'Saisis un prénom et un nom RP valides (2 à 64 caractères chacun).' });
      }
      const result = await db.completeOfficerProfile({ username: user.u, rio: user.rio, discordId: user.discord_id, firstName, lastName });
      if (!result.ok) return send(res, 404, { ok: false, error: 'Compte agent introuvable. Contacte un responsable.' });
      const updatedUser = normalizeOfficer(result.officer);
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
      if (token && sessions.has(token)) sessions.get(token).user = updatedUser;
      return send(res, 200, { ok: true, user: updatedUser });
    }

    if (!user.profileCompleted) return send(res, 403, { ok: false, error: 'Complète ton profil avant d’utiliser le portail.', code: 'PROFILE_REQUIRED' });

    if (path === '/api/officers/accounts' && req.method === 'GET') {
      if (!user.admin) return send(res, 403, { ok: false, error: 'Réservé à l’administrateur du site.' });
      return send(res, 200, { ok: true, accounts: await db.getPortalAccounts() });
    }

    if (path === '/api/management/history' && req.method === 'GET') {
      if (!canManageHr(user)) return send(res, 403, { ok: false, error: 'La gestion RH est réservée aux deux grades de direction.' });
      return send(res, 200, { ok: true, history: await db.getManagementHistory(30) });
    }

    if (path === '/api/calendar/events' && req.method === 'GET') {
      return send(res, 200, { ok: true, events: await db.getCalendarEvents() });
    }
    if (path === '/api/calendar/events/import-legacy' && req.method === 'POST') {
      const body = await readJson(req, 2 * 1024 * 1024);
      if (!Array.isArray(body.events) || body.events.length > 2000) {
        return send(res, 400, { ok: false, error: 'Liste d’événements invalide.' });
      }
      const imported = await db.importLegacyCalendarEvents(body.events);
      return send(res, 200, { ok: true, imported, events: await db.getCalendarEvents() });
    }
    if (path === '/api/calendar/events' && req.method === 'PUT') {
      const body = await readJson(req);
      const id = String(body.id || '').trim();
      const title = String(body.title || '').trim();
      const date = String(body.date || '').trim();
      if (!id || id.length > 80 || !title || title.length > 180 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return send(res, 400, { ok: false, error: 'Titre, date ou identifiant invalide.' });
      }
      const event = await db.upsertCalendarEvent({
        ...body,
        id,
        title,
        date,
        author: body.author || `${user.nom || user.u} (#${user.rio || user.mat || '—'})`
      });
      return send(res, 200, { ok: true, event });
    }
    const calendarEventMatch = /^\/api\/calendar\/events\/([A-Za-z0-9_-]{1,80})$/.exec(path);
    if (calendarEventMatch && req.method === 'DELETE') {
      const deleted = await db.deleteCalendarEvent(calendarEventMatch[1]);
      if (!deleted) return send(res, 404, { ok: false, error: 'Événement introuvable.' });
      return send(res, 200, { ok: true });
    }

    if (path === '/api/officers' && req.method === 'GET') {
      const officers = await db.getPublicOfficers();
      return send(res, 200, { ok: true, officers: officers.map(officer => {
        const nameParts = String(officer.nom || '').trim().split(/\s+/);
        return {
          badge: String(officer.rio), firstName: nameParts.shift() || '', lastName: nameParts.join(' '),
          grade: officer.grade || 'Agent PM', specialties: officer.specialties || [],
          status: officer.service_status === 'EN_SERVICE' ? 'En service' : officer.service_status === 'EN_PAUSE' ? 'En pause' : 'Hors service',
          salary: Number(officer.salary || 0), notes: officer.notes || '', awards: officer.awards || [], warnings: officer.warnings || [],
          weekHours: Number(officer.week_hours || 0), totalHours: Number(officer.total_hours || 0)
        };
      }) });
    }

    const officerRoute = /^\/api\/officers\/([^/]+)$/.exec(path);
    if (officerRoute && req.method === 'PUT') {
      if (!canManageHr(user)) return send(res, 403, { ok: false, error: 'La gestion RH est réservée aux deux grades de direction.' });
      const rio = decodeURIComponent(officerRoute[1]);
      const body = await readJson(req);
      const existing = await db.getOfficerByRio(rio);
      if (!existing || !existing.profile_completed) return send(res, 404, { ok: false, error: 'Agent introuvable.' });
      const grade = String(body.grade || '').trim();
      const salary = Number(body.salary);
      const specialties = Array.isArray(body.specialties) ? body.specialties.map(x => String(x).trim()).filter(Boolean) : [];
      const awards = Array.isArray(body.awards) ? body.awards.map(x => String(x).trim()).filter(Boolean) : [];
      const warnings = Array.isArray(body.warnings) ? body.warnings.map(x => String(x).trim()).filter(Boolean) : [];
      const notes = String(body.notes || '').trim();
      if (!grade || grade.length > 128 || !Number.isFinite(salary) || salary < 0 || salary > 100000) {
        return send(res, 400, { ok: false, error: 'Grade ou traitement mensuel invalide.' });
      }
      if (specialties.length > 40 || specialties.some(x => x.length > 100) || awards.length > 50 || warnings.length > 50 || [...awards, ...warnings].some(x => x.length > 250) || notes.length > 5000) {
        return send(res, 400, { ok: false, error: 'Le dossier contient trop de valeurs ou un texte trop long.' });
      }
      const beforeSpecialties = (() => { try { return JSON.parse(existing.specialties || '[]'); } catch { return []; } })();
      const changes = [];
      if (existing.grade !== grade) changes.push(`Grade : ${existing.grade} → ${grade}`);
      if (Number(existing.salary || 0) !== salary) changes.push(`Traitement réévalué à ${salary} €`);
      if (JSON.stringify([...beforeSpecialties].sort()) !== JSON.stringify([...specialties].sort())) changes.push(`Affectations modifiées (${specialties.length} spécialités)`);
      if (String(existing.notes || '') !== notes) changes.push('Observations modifiées');
      const oldAwards = (() => { try { return JSON.parse(existing.awards || '[]'); } catch { return []; } })();
      const oldWarnings = (() => { try { return JSON.parse(existing.warnings || '[]'); } catch { return []; } })();
      if (JSON.stringify(oldAwards) !== JSON.stringify(awards)) changes.push('Décorations modifiées');
      if (JSON.stringify(oldWarnings) !== JSON.stringify(warnings)) changes.push('Avertissements modifiés');
      const action = changes[0] || 'Dossier RH actualisé';
      const author = `${user.grade} ${user.nom} (RIO #${user.rio})`;
      const officer = await db.updateOfficerHr(rio, { grade, salary, specialties, notes, awards, warnings, action, details: changes.join(' • ') || 'Aucun changement de valeur.' }, author);
      if (!officer) return send(res, 404, { ok: false, error: 'Agent introuvable.' });
      const nameParts = String(officer.nom || '').trim().split(/\s+/);
      return send(res, 200, { ok: true, officer: {
        badge: String(officer.rio), firstName: nameParts.shift() || '', lastName: nameParts.join(' '),
        grade: officer.grade, specialties, salary: Number(officer.salary || 0), notes: officer.notes || '',
        awards: parseJsonArray(officer.awards), warnings: parseJsonArray(officer.warnings)
      }, history: await db.getManagementHistory(30) });
    }

    if (officerRoute && req.method === 'DELETE') {
      if (!canDeleteSiteAccounts(user)) return send(res, 403, { ok: false, error: 'Seul le compte administrateur principal peut supprimer des comptes.' });
      const rio = decodeURIComponent(officerRoute[1]);
      const target = await db.getOfficerByRio(rio);
      if (target?.username === user.u) return send(res, 400, { ok: false, error: 'Tu ne peux pas supprimer le compte actuellement connecté.' });
      const result = await db.deleteOfficerAccount(rio);
      if (!result.ok && result.reason === 'protected') return send(res, 403, { ok: false, error: 'Le compte administrateur principal est protégé.' });
      if (!result.ok) return send(res, 404, { ok: false, error: 'Compte introuvable.' });
      for (const [token, session] of sessions.entries()) {
        if (session.user.u === result.officer.username) sessions.delete(token);
      }
      return send(res, 200, { ok: true });
    }

    if (path === '/api/auth/discord-link' && req.method === 'POST') {
      const body = await readJson(req);
      const discordId = String(body.discord_id || '').trim();
      if (discordId && !/^\d{17,20}$/.test(discordId)) return send(res, 400, { ok: false, error: 'ID Discord invalide : saisis l’ID numérique (17 à 20 chiffres).' });
      const result = await db.setOfficerDiscordId(user.rio, discordId);
      if (!result.ok && result.reason === 'already_linked') return send(res, 409, { ok: false, error: 'Cet ID Discord est déjà associé à un autre compte.' });
      if (!result.ok) return send(res, 404, { ok: false, error: 'Compte agent introuvable.' });
      const updatedUser = normalizeOfficer(result.officer);
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
      if (token && sessions.has(token)) sessions.get(token).user = updatedUser;
      return send(res, 200, { ok: true, user: updatedUser });
    }

    if (path === '/api/service/status' && req.method === 'GET') {
      const rio = String(url.searchParams.get('rio') || user.rio);
      const [activeServices, csuState, patrols, reports, currentService] = await Promise.all([
        db.getAllActiveServices(), db.getCsuState(), db.getAllPatrols(), db.getRecentServiceReports(30),
        db.getActiveServiceByRio(rio)
      ]);
      return send(res, 200, { ok: true, currentService, activeServices, csuState, patrols, reports });
    }

    if (path === '/api/service/start' && req.method === 'POST') {
      const body = await readJson(req);
      const active = await db.getActiveServiceByRio(user.rio);
      if (active) return send(res, 409, { ok: false, error: 'Vous êtes déjà en service. Reprenez votre service ou terminez-le avant d’en commencer un autre.' });
      const service = await db.startService({ rio: user.rio, discord_id: user.discord_id, nom: user.nom, grade: user.grade, is_csu: body.is_csu ? 1 : 0 });
      if (service?.alreadyActive) return send(res, 409, { ok: false, error: 'Vous êtes déjà en service. Reprenez votre service ou terminez-le avant d’en commencer un autre.' });
      return send(res, 200, { ok: true, service: await db.getActiveServiceByRio(user.rio) || service });
    }
    if (path === '/api/service/pause' && req.method === 'POST') {
      return send(res, 200, { ok: true, service: await db.togglePauseService(user.rio) });
    }
    if (path === '/api/service/stop' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { ok: true, service: await db.stopService(user.rio, { report: body.report, discord_id: user.discord_id }) });
    }
    if (path === '/api/service/csu' && req.method === 'POST') {
      const body = await readJson(req);
      const state = await db.getCsuState();
      if (body.action === 'release') {
        if (!user.admin && String(state?.operator_rio) !== String(user.rio)) return send(res, 403, { ok: false, error: 'Action non autorisée' });
        await db.clearCsuOperator();
      } else {
        const active = await db.getActiveServiceByRio(user.rio);
        if (!active) await db.startService({ rio: user.rio, discord_id: user.discord_id, nom: user.nom, grade: user.grade, is_csu: 1 });
        else await db.setCsuOperator({ rio: user.rio, discord_id: user.discord_id, nom: user.nom });
      }
      return send(res, 200, { ok: true, csuState: await db.getCsuState() });
    }

    if (path === '/api/patrols' && req.method === 'GET') return send(res, 200, { ok: true, patrols: await db.getAllPatrols() });
    if (path === '/api/patrols' && req.method === 'POST') {
      if (!user.admin) return send(res, 403, { ok: false, error: 'Droits administrateur requis' });
      const body = await readJson(req);
      if (!String(body.name || '').trim()) return send(res, 400, { ok: false, error: 'Nom de patrouille requis' });
      await db.createPatrol({ name: body.name, type: body.type, radio_indicatif: body.radio_indicatif, created_by: user.nom });
      return send(res, 200, { ok: true, patrols: await db.getAllPatrols() });
    }
    if (path.startsWith('/api/patrols/') && req.method === 'DELETE') {
      if (!user.admin) return send(res, 403, { ok: false, error: 'Droits administrateur requis' });
      const id = decodeURIComponent(path.slice('/api/patrols/'.length));
      if (!/^\d+$/.test(id)) return send(res, 400, { ok: false, error: 'Identifiant de patrouille invalide' });
      await db.deletePatrol(Number(id));
      return send(res, 200, { ok: true, patrols: await db.getAllPatrols() });
    }
    if ((path === '/api/patrols/assign' || path === '/api/patrols/unassign') && req.method === 'POST') {
      if (!user.admin) return send(res, 403, { ok: false, error: 'Droits administrateur requis' });
      const body = await readJson(req);
      if (!body.rio) return send(res, 400, { ok: false, error: 'RIO manquant' });
      if (path.endsWith('/assign')) {
        if (!body.patrolName) return send(res, 400, { ok: false, error: 'Patrouille manquante' });
        await db.assignOfficerToPatrol(String(body.rio), String(body.patrolName));
      } else await db.unassignOfficerFromPatrol(String(body.rio));
      return send(res, 200, { ok: true });
    }

    if (path === '/api/casiers' && req.method === 'GET') return send(res, 200, await db.getAllCasiers());
    if (path === '/api/casiers' && req.method === 'POST') {
      const body = await readJson(req);
      const result = await db.saveCasier(body.record, user);
      return send(res, 200, { ok: true, ...result });
    }
    if (path === '/api/casiers/import-legacy' && req.method === 'POST') {
      if (!user.admin) return send(res, 403, { ok: false, error: 'Import historique réservé à l’administrateur.' });
      const body = await readJson(req, 8 * 1024 * 1024);
      if (!Array.isArray(body.records) || body.records.length > 2000) return send(res, 400, { ok: false, error: 'Archive de casiers invalide.' });
      const imported = await db.importLegacyCasiers(body.records);
      return send(res, 200, { ok: true, imported, casiers: await db.getAllCasiers() });
    }
    const casierReviewMatch = /^\/api\/casiers\/([A-Za-z0-9_-]{1,64})\/review$/.exec(path);
    if (casierReviewMatch && req.method === 'POST') {
      const body = await readJson(req);
      const casier = await db.reviewCasier(casierReviewMatch[1], { approved: Boolean(body.approved), note: body.note }, user);
      if (!casier) return send(res, 404, { ok: false, error: 'Casier introuvable.' });
      return send(res, 200, { ok: true, casier, casiers: await db.getAllCasiers() });
    }
    const casierMatch = /^\/api\/casiers\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (casierMatch && req.method === 'DELETE') {
      const deleted = await db.deleteCasier(casierMatch[1], user);
      if (!deleted) return send(res, 404, { ok: false, error: 'Casier introuvable.' });
      return send(res, 200, { ok: true, casiers: await db.getAllCasiers() });
    }
    if (path === '/api/bot/status' && req.method === 'GET') {
      const pool = await db.getPool();
      const [rows] = await pool.query('SELECT * FROM pm_bot_heartbeat WHERE id = 1');
      const heartbeat = rows[0] || {};
      const lastHeartbeat = Number(heartbeat.last_heartbeat || 0);
      const online = lastHeartbeat > 0 && (Date.now() - lastHeartbeat) < 300000;
      let guilds = [];
      try { guilds = JSON.parse(heartbeat.guilds_info || '[]'); } catch { guilds = []; }
      const [activeServices, csu] = await Promise.all([db.getAllActiveServices(), db.getCsuState()]);
      return send(res, 200, {
        ok: true,
        botStatus: {
          online,
          ping: online ? Number(heartbeat.ping_ms || 0) : 0,
          user: online ? { id: heartbeat.bot_id || '', tag: heartbeat.bot_name || 'Bot Police Municipale' } : null,
          guilds: online ? guilds : []
        },
        monitoring: {
          frequency: 'Canal 20 (20.0 MHz)',
          activeServicesCount: activeServices.length,
          csuOperator: csu?.operator_name || 'Aucun (Standard vacant)',
          databaseSync: true,
          hostArchitecture: 'Bot Discord autonome — état reçu par heartbeat MySQL'
        }
      });
    }
    if (path.startsWith('/api/bot/')) return send(res, 503, { ok: false, error: 'Le bot Discord reste hébergé séparément.' });
    return send(res, 404, { ok: false, error: 'Route API inconnue' });
  } catch (err) {
    console.error('[API]', path, err.message);
    return send(res, err.status || 500, { ok: false, error: err.status ? err.message : 'Erreur serveur API' });
  }
});

async function main() {
  await db.initDatabase();
  server.listen(PORT, '0.0.0.0', () => console.log(`API Render prête sur le port ${PORT}`));
}

main().catch(err => {
  console.error('Échec du démarrage de l’API :', err.message);
  process.exit(1);
});
