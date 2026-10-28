require('dotenv').config();
const mysql = require('mysql2/promise');

let pool = null;

async function getPool() {
  if (!pool) {
    const missing = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter((key) => !process.env[key]);
    if (missing.length) throw new Error(`Configuration MySQL manquante : ${missing.join(', ')}`);
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 5000
    });
  }
  return pool;
}

// Initialise all PM tables in MySQL
async function initDatabase() {
  const p = await getPool();

  // 1. Config
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_config (
      key_name VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 2. Officers
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_officers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(32) NULL UNIQUE,
      username VARCHAR(64) NOT NULL UNIQUE,
      rio VARCHAR(32) NOT NULL UNIQUE,
      nom VARCHAR(128) NOT NULL,
      grade VARCHAR(128) NOT NULL DEFAULT 'Gardien-brigadier',
      specialties TEXT NULL,
      password VARCHAR(255) DEFAULT 'pm1234',
      website_access TINYINT(1) NOT NULL DEFAULT 0,
      is_admin TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try {
    await p.query('ALTER TABLE pm_officers ADD COLUMN website_access TINYINT(1) NOT NULL DEFAULT 0');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  await p.query("ALTER TABLE pm_officers MODIFY password VARCHAR(255) DEFAULT 'pm1234'");

  // 3. Services (Pointeuse)
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_services (
      id INT AUTO_INCREMENT PRIMARY KEY,
      officer_rio VARCHAR(32) NOT NULL,
      discord_id VARCHAR(32) NULL,
      nom VARCHAR(128) NOT NULL,
      grade VARCHAR(128) DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'EN_SERVICE',
      is_csu TINYINT(1) DEFAULT 0,
      patrol_name VARCHAR(64) DEFAULT NULL,
      start_time BIGINT NOT NULL,
      pause_time BIGINT NULL,
      total_pause_ms BIGINT DEFAULT 0,
      end_time BIGINT NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_status (status),
      INDEX idx_rio (officer_rio)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 4. Patrols / Equipages
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_patrols (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(64) NOT NULL UNIQUE,
      type VARCHAR(64) NOT NULL DEFAULT 'Véhicule sérigraphié',
      radio_indicatif VARCHAR(64) DEFAULT NULL,
      status VARCHAR(32) DEFAULT 'DISPONIBLE',
      created_by VARCHAR(64) DEFAULT 'Admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 5. CSU Operator state
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_csu (
      id INT PRIMARY KEY DEFAULT 1,
      operator_rio VARCHAR(32) NULL,
      operator_name VARCHAR(128) NULL,
      operator_discord_id VARCHAR(32) NULL,
      started_at BIGINT NULL,
      notes TEXT NULL,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 6. Service Reports (Historique des vacations terminées)
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_service_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      officer_rio VARCHAR(32) NOT NULL,
      officer_name VARCHAR(128) NOT NULL,
      date VARCHAR(32) NOT NULL,
      start_time VARCHAR(32) NOT NULL,
      end_time VARCHAR(32) NOT NULL,
      duration_hours FLOAT NOT NULL DEFAULT 0,
      type VARCHAR(64) DEFAULT 'Patrouille Terrain',
      report TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_report_rio (officer_rio)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Ensure cumulative hours columns in pm_officers
  try {
    await p.query('ALTER TABLE pm_officers ADD COLUMN week_hours FLOAT DEFAULT 0');
  } catch (_) {}
  try {
    await p.query('ALTER TABLE pm_officers ADD COLUMN total_hours FLOAT DEFAULT 0');
  } catch (_) {}

  // Seed default admin officer if none exists
  const [officers] = await p.query('SELECT COUNT(*) as cnt FROM pm_officers');
  if (officers[0].cnt === 0) {
    const defaultSpecs = JSON.stringify([
      'Vidéoprotection (CSU)',
      'Chef Vidéoprotection (csu)',
      'GSI',
      'Chef GSI'
    ]);
    await p.query(
      `INSERT INTO pm_officers (discord_id, username, rio, nom, grade, specialties, password, is_admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['813078585266012160', 'admin', '1340799', 'Wade Winters', 'Directeur de Police Municipale', defaultSpecs, 'admin', 1]
    );
  }

  // Préserver l'accès des comptes administrateurs déjà en place après l'ajout du contrôle website_access.
  await p.query("UPDATE pm_officers SET website_access = 1 WHERE is_admin = 1 OR LOWER(username) = 'admin'");

  // Seed default CSU row if not exists
  const [csuRows] = await p.query('SELECT COUNT(*) as cnt FROM pm_csu WHERE id = 1');
  if (csuRows[0].cnt === 0) {
    await p.query(`INSERT INTO pm_csu (id, operator_rio, operator_name, operator_discord_id, started_at, updated_at) VALUES (1, NULL, NULL, NULL, NULL, ?)`, [Date.now()]);
  }

  // Seed standard patrols if none exist
  const [patrolRows] = await p.query('SELECT COUNT(*) as cnt FROM pm_patrols');
  if (patrolRows[0].cnt === 0) {
    const defaultPatrols = [
      ['PAM 1 - Alpha', 'Véhicule sérigraphié', 'Alpha-1'],
      ['PAM 2 - Bravo', 'Véhicule sérigraphié', 'Bravo-1'],
      ['Brigade GSI 1', 'Véhicule banalisé GSI', 'GSI-Echo'],
      ['Brigade Cynophile', 'Véhicule cynophile', 'Cyno-K9'],
      ['Brigade Motocycliste 1', 'Moto d\'intervention', 'Moto-1'],
      ['Brigade VTT 1', 'VTT Police', 'VTT-1']
    ];
    for (const [name, type, indicatif] of defaultPatrols) {
      await p.query(`INSERT IGNORE INTO pm_patrols (name, type, radio_indicatif) VALUES (?, ?, ?)`, [name, type, indicatif]);
    }
  }

  // 7. Bot Heartbeat (monitoring du bot Discord par le site PHP)
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_bot_heartbeat (
      id INT PRIMARY KEY DEFAULT 1,
      bot_name VARCHAR(128) DEFAULT '',
      bot_id VARCHAR(64) DEFAULT '',
      status VARCHAR(32) DEFAULT 'offline',
      ping_ms INT DEFAULT 0,
      guilds_count INT DEFAULT 0,
      guilds_info TEXT,
      last_heartbeat BIGINT DEFAULT 0,
      updated_at BIGINT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Seed heartbeat row
  const [hbRows] = await p.query('SELECT COUNT(*) as cnt FROM pm_bot_heartbeat WHERE id = 1');
  if (hbRows[0].cnt === 0) {
    await p.query("INSERT INTO pm_bot_heartbeat (id, status, last_heartbeat, updated_at) VALUES (1, 'offline', 0, 0)");
  }

  // 8. Casiers (stockage MySQL au lieu de JSON fichier)
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_casiers (
      id VARCHAR(64) PRIMARY KEY,
      no INT DEFAULT 0,
      suspect_name VARCHAR(255) DEFAULT '',
      location VARCHAR(255) DEFAULT '',
      data_json LONGTEXT,
      saved_by VARCHAR(64) DEFAULT 'admin',
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_casier_no (no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 9. Absences
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_absences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discord_id VARCHAR(32) NOT NULL,
      nom VARCHAR(128) NOT NULL,
      rio VARCHAR(32) DEFAULT '',
      motif TEXT NOT NULL,
      date_debut VARCHAR(64) DEFAULT '',
      date_fin VARCHAR(64) DEFAULT '',
      status VARCHAR(32) NOT NULL DEFAULT 'EN_ATTENTE',
      acked_by VARCHAR(32) NULL,
      acked_by_name VARCHAR(128) NULL,
      acked_at BIGINT NULL,
      message_id VARCHAR(32) NULL,
      channel_id VARCHAR(32) NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_absence_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // 10. Sessions PHP
  await p.query(`
    CREATE TABLE IF NOT EXISTS pm_sessions (
      token VARCHAR(128) PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      user_data TEXT,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      INDEX idx_session_user (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('✅ Base de données MySQL initialisée avec succès sur Bot Hosting.');
}

// Config helpers
async function getConfig(key, fallback = null) {
  try {
    const p = await getPool();
    const [rows] = await p.query('SELECT value FROM pm_config WHERE key_name = ?', [key]);
    if (rows.length > 0) return rows[0].value;
    return fallback;
  } catch (err) {
    console.error(`getConfig error for ${key}:`, err.message);
    return fallback;
  }
}

async function setConfig(key, value) {
  const p = await getPool();
  await p.query(
    'INSERT INTO pm_config (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
    [key, String(value)]
  );
}

// Officers helpers
async function getOfficerByUsername(username) {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_officers WHERE LOWER(username) = LOWER(?)', [username]);
  return rows[0] || null;
}

async function getOfficerByDiscordId(discordId) {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_officers WHERE discord_id = ?', [discordId]);
  return rows[0] || null;
}

async function getOfficerByRio(rio) {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_officers WHERE rio = ?', [rio]);
  return rows[0] || null;
}

async function getAllOfficers() {
  const p = await getPool();
  const [rows] = await p.query('SELECT id, discord_id, username, rio, nom, grade, specialties, is_admin, created_at FROM pm_officers ORDER BY nom ASC');
  return rows.map(r => ({
    ...r,
    specialties: typeof r.specialties === 'string' ? JSON.parse(r.specialties || '[]') : (r.specialties || [])
  }));
}

async function saveOfficer(data) {
  const p = await getPool();
  const specs = JSON.stringify(data.specialties || []);
  await p.query(
    `INSERT INTO pm_officers (discord_id, username, rio, nom, grade, specialties, password, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       discord_id = VALUES(discord_id),
       rio = VALUES(rio),
       nom = VALUES(nom),
       grade = VALUES(grade),
       specialties = VALUES(specialties),
       password = COALESCE(VALUES(password), password),
       is_admin = VALUES(is_admin)`,
    [
      data.discord_id || null,
      data.username.toLowerCase(),
      data.rio,
      data.nom,
      data.grade || 'Gardien-brigadier',
      specs,
      data.password || 'pm1234',
      data.is_admin ? 1 : 0
    ]
  );
}

async function deleteOfficer(rioOrUsername) {
  const p = await getPool();
  await p.query('DELETE FROM pm_officers WHERE rio = ? OR username = ?', [rioOrUsername, rioOrUsername]);
}

async function ensureOfficerRio(discordUser, member = null) {
  if (!discordUser || !discordUser.id) return null;
  const p = await getPool();
  
  // 1. Chercher si déjà existant par discord_id
  let [rows] = await p.query('SELECT * FROM pm_officers WHERE discord_id = ?', [discordUser.id]);
  if (rows.length > 0) return rows[0];

  // 2. Détecter le grade via les rôles Discord si member est fourni
  let detectedGrade = 'Gardien-brigadier';
  try {
    const { HIERARCHY_ROLES } = require('./constants/roles');
    if (member && member.roles && member.roles.cache) {
      for (const g of HIERARCHY_ROLES) {
        if (member.roles.cache.some(r => r.name.toLowerCase() === g.name.toLowerCase() || r.name.toLowerCase().includes(g.name.toLowerCase()))) {
          detectedGrade = g.name;
          break;
        }
      }
    }
  } catch (_) {}

  // 3. Générer un RIO unique à 7 chiffres (ex: 134XXXX)
  let generatedRio = '';
  let exists = true;
  let safety = 0;
  while (exists && safety < 100) {
    safety++;
    generatedRio = '134' + Math.floor(1000 + Math.random() * 9000);
    const [chk] = await p.query('SELECT id FROM pm_officers WHERE rio = ?', [generatedRio]);
    if (chk.length === 0) exists = false;
  }

  const nom = member?.displayName || discordUser.globalName || discordUser.username || 'Agent';
  const username = (discordUser.username || `pm_${discordUser.id}`).toLowerCase();

  await p.query(
    `INSERT INTO pm_officers (discord_id, username, rio, nom, grade, specialties, password, is_admin)
     VALUES (?, ?, ?, ?, ?, '[]', 'pm1234', 0)
     ON DUPLICATE KEY UPDATE
       discord_id = VALUES(discord_id),
       nom = VALUES(nom),
       grade = VALUES(grade)`,
    [discordUser.id, username, generatedRio, nom, detectedGrade]
  );

  const [res] = await p.query('SELECT * FROM pm_officers WHERE discord_id = ?', [discordUser.id]);
  return res[0] || null;
}

// Service (Pointeuse) helpers
async function getActiveServiceByRio(rio) {
  const p = await getPool();
  const [rows] = await p.query(
    "SELECT * FROM pm_services WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE') ORDER BY id DESC LIMIT 1",
    [rio]
  );
  return rows[0] || null;
}

async function getActiveServiceByDiscordId(discordId) {
  const p = await getPool();
  const [rows] = await p.query(
    "SELECT * FROM pm_services WHERE discord_id = ? AND status IN ('EN_SERVICE', 'EN_PAUSE') ORDER BY id DESC LIMIT 1",
    [discordId]
  );
  return rows[0] || null;
}

async function getAllActiveServices() {
  const p = await getPool();
  const [rows] = await p.query(
    "SELECT * FROM pm_services WHERE status IN ('EN_SERVICE', 'EN_PAUSE') ORDER BY start_time ASC"
  );
  return rows;
}

async function setOfficerPatrol(rio, patrolName) {
  const p = await getPool();
  const cleanName = (patrolName || '').trim();
  const val = (cleanName === '' || cleanName.toLowerCase() === 'quitter' || cleanName.toLowerCase() === 'aucun') ? null : cleanName;
  await p.query(
    "UPDATE pm_services SET patrol_name = ?, updated_at = ? WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE')",
    [val, Date.now(), rio]
  );
  return val;
}

async function startService({ rio, discord_id, nom, grade, is_csu = 0, patrol_name = null }) {
  const p = await getPool();
  // End any stale active service first
  await p.query(
    "UPDATE pm_services SET status = 'TERMINE', end_time = ? WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE')",
    [Date.now(), rio]
  );

  const now = Date.now();
  const cleanPatrol = patrol_name && patrol_name.trim() !== '' ? patrol_name.trim() : null;
  const [res] = await p.query(
    `INSERT INTO pm_services (officer_rio, discord_id, nom, grade, status, is_csu, patrol_name, start_time, total_pause_ms, updated_at)
     VALUES (?, ?, ?, ?, 'EN_SERVICE', ?, ?, ?, 0, ?)`,
    [rio, discord_id || null, nom, grade || '', is_csu ? 1 : 0, cleanPatrol, now, now]
  );

  if (is_csu) {
    await setCsuOperator({ rio, nom, discord_id });
  }

  return { id: res.insertId, status: 'EN_SERVICE', patrol_name: cleanPatrol };
}

async function togglePauseService(rio) {
  const p = await getPool();
  const active = await getActiveServiceByRio(rio);
  if (!active) return null;

  const now = Date.now();
  if (active.status === 'EN_SERVICE') {
    // Go to pause
    await p.query(
      "UPDATE pm_services SET status = 'EN_PAUSE', pause_time = ?, updated_at = ? WHERE id = ?",
      [now, now, active.id]
    );
    return { ...active, status: 'EN_PAUSE', pause_time: now };
  } else if (active.status === 'EN_PAUSE') {
    // Resume from pause
    const pauseDuration = active.pause_time ? (now - active.pause_time) : 0;
    const newTotalPause = (active.total_pause_ms || 0) + pauseDuration;
    await p.query(
      "UPDATE pm_services SET status = 'EN_SERVICE', pause_time = NULL, total_pause_ms = ?, updated_at = ? WHERE id = ?",
      [newTotalPause, now, active.id]
    );
    return { ...active, status: 'EN_SERVICE', pause_time: null, total_pause_ms: newTotalPause };
  }
  return null;
}

async function stopService(rio) {
  const p = await getPool();
  const active = await getActiveServiceByRio(rio);
  if (!active) return null;

  const now = Date.now();
  let addedPause = 0;
  if (active.status === 'EN_PAUSE' && active.pause_time) {
    addedPause = now - active.pause_time;
  }
  const totalPause = (active.total_pause_ms || 0) + addedPause;
  const workedMs = Math.max(0, (now - active.start_time) - totalPause);
  let hoursWorked = Math.round((workedMs / 3600000) * 100) / 100;
  if (workedMs >= 10000 && hoursWorked < 0.05) {
    hoursWorked = 0.05; // Plancher 3min pour réactivité RP
  }

  await p.query(
    "UPDATE pm_services SET status = 'TERMINE', end_time = ?, total_pause_ms = ?, updated_at = ? WHERE id = ?",
    [now, totalPause, now, active.id]
  );

  // Cumul des heures de service de l'agent
  await p.query(
    "UPDATE pm_officers SET week_hours = COALESCE(week_hours, 0) + ?, total_hours = COALESCE(total_hours, 0) + ? WHERE rio = ?",
    [hoursWorked, hoursWorked, rio]
  );

  const startDate = new Date(active.start_time);
  const endDate = new Date(now);
  const dateStr = startDate.toISOString().split('T')[0];
  const startTimeStr = startDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const endTimeStr = endDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const typeStr = active.is_csu ? 'Supervision Vidéoprotection (CSU)' : (active.patrol_name || 'Patrouille Opérationnelle');
  const pauseMin = Math.floor(totalPause / 60000);
  const reportStr = `Vacation officielle achevée (${hoursWorked}h validées). Pause déduite : ${pauseMin} min.`;

  try {
    await p.query(
      `INSERT INTO pm_service_reports (officer_rio, officer_name, date, start_time, end_time, duration_hours, type, report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [rio, active.nom, dateStr, startTimeStr, endTimeStr, hoursWorked, typeStr, reportStr]
    );
  } catch (err) {
    console.warn('Erreur log service report:', err.message);
  }

  // If this officer was the CSU operator, release CSU
  const csu = await getCsuState();
  if (csu && csu.operator_rio === rio) {
    await clearCsuOperator();
  }

  const logEntry = {
    id: `serv-${Date.now()}`,
    officerBadge: rio,
    officerName: active.nom,
    date: dateStr,
    startTime: startTimeStr,
    endTime: endTimeStr,
    durationHours: hoursWorked,
    type: typeStr,
    report: reportStr
  };

  return {
    ...active,
    status: 'TERMINE',
    end_time: now,
    total_pause_ms: totalPause,
    duration_hours: hoursWorked,
    log: logEntry
  };
}

async function getRecentServiceReports(limit = 25) {
  try {
    const p = await getPool();
    const [rows] = await p.query(
      'SELECT * FROM pm_service_reports ORDER BY id DESC LIMIT ?',
      [limit]
    );
    return rows;
  } catch (_) {
    return [];
  }
}

// CSU state helpers
async function getCsuState() {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_csu WHERE id = 1');
  return rows[0] || null;
}

async function setCsuOperator({ rio, nom, discord_id }) {
  const p = await getPool();
  const now = Date.now();
  await p.query(
    `INSERT INTO pm_csu (id, operator_rio, operator_name, operator_discord_id, started_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       operator_rio = VALUES(operator_rio),
       operator_name = VALUES(operator_name),
       operator_discord_id = VALUES(operator_discord_id),
       started_at = VALUES(started_at),
       updated_at = VALUES(updated_at)`,
    [rio, nom, discord_id || null, now, now]
  );

  // Also mark service as is_csu = 1
  await p.query(
    "UPDATE pm_services SET is_csu = 1, updated_at = ? WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE')",
    [now, rio]
  );
}

async function clearCsuOperator() {
  const p = await getPool();
  const now = Date.now();
  const current = await getCsuState();
  if (current && current.operator_rio) {
    await p.query(
      "UPDATE pm_services SET is_csu = 0, updated_at = ? WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE')",
      [now, current.operator_rio]
    );
  }
  await p.query(
    'UPDATE pm_csu SET operator_rio = NULL, operator_name = NULL, operator_discord_id = NULL, started_at = NULL, updated_at = ? WHERE id = 1',
    [now]
  );
}

// Patrol helpers
async function getAllPatrols() {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_patrols ORDER BY name ASC');
  return rows;
}

async function createPatrol({ name, type = 'Véhicule sérigraphié', radio_indicatif = '', created_by = 'Admin' }) {
  const p = await getPool();
  await p.query(
    'INSERT INTO pm_patrols (name, type, radio_indicatif, created_by) VALUES (?, ?, ?, ?)',
    [name.trim(), type.trim(), radio_indicatif.trim(), created_by]
  );
}

async function deletePatrol(patrolId) {
  const p = await getPool();
  // Get patrol name to unassign
  const [pRows] = await p.query('SELECT name FROM pm_patrols WHERE id = ?', [patrolId]);
  if (pRows.length > 0) {
    const patrolName = pRows[0].name;
    await p.query('UPDATE pm_services SET patrol_name = NULL WHERE patrol_name = ?', [patrolName]);
  }
  await p.query('DELETE FROM pm_patrols WHERE id = ?', [patrolId]);
}

async function assignOfficerToPatrol(rio, patrolName) {
  const p = await getPool();
  const now = Date.now();
  await p.query(
    "UPDATE pm_services SET patrol_name = ?, updated_at = ? WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE')",
    [patrolName, now, rio]
  );
}

async function unassignOfficerFromPatrol(rio) {
  const p = await getPool();
  const now = Date.now();
  await p.query(
    "UPDATE pm_services SET patrol_name = NULL, updated_at = ? WHERE officer_rio = ? AND status IN ('EN_SERVICE', 'EN_PAUSE')",
    [now, rio]
  );
}

function parseCasierRow(row) {
  let data = {};
  try {
    data = typeof row.data_json === 'string' ? JSON.parse(row.data_json || '{}') : (row.data_json || {});
  } catch (_) {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};

  const merged = {
    ...data,
    db_id: row.id,
    id: data.id || row.id,
    no: data.no || row.no,
    saved_by: row.saved_by || data.by || data.agentNom,
    saved_at: row.saved_at,
    location: data.lieu || row.location || '',
    suspect_name: row.suspect_name || [data.prenom, data.nom].filter(Boolean).join(' ')
  };

  if (!merged.nom && row.suspect_name) {
    const parts = String(row.suspect_name).trim().split(/\s+/);
    if (parts.length >= 2) {
      merged.prenom = merged.prenom || parts[0];
      merged.nom = parts.slice(1).join(' ');
    } else {
      merged.nom = row.suspect_name;
    }
  }
  if (!merged.lieu && row.location) merged.lieu = row.location;

  if (merged.lines && !Array.isArray(merged.lines)) {
    merged.lines = Object.values(merged.lines);
  }
  if (!Array.isArray(merged.lines)) merged.lines = [];

  return merged;
}

async function getAllCasiers() {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_casiers ORDER BY no ASC, saved_at ASC');
  return rows.map(parseCasierRow);
}

async function getCasierByIdOrNo(idOrNo) {
  const p = await getPool();
  const key = String(idOrNo || '').trim();
  if (!key) return null;
  const [rows] = await p.query(
    'SELECT * FROM pm_casiers WHERE id = ? OR CAST(no AS CHAR) = ? LIMIT 1',
    [key, key]
  );
  return rows[0] ? parseCasierRow(rows[0]) : null;
}

async function createAbsence(data) {
  const p = await getPool();
  const now = Date.now();
  const [res] = await p.query(
    `INSERT INTO pm_absences (discord_id, nom, rio, motif, date_debut, date_fin, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'EN_ATTENTE', ?)`,
    [
      data.discord_id,
      data.nom,
      data.rio || '',
      data.motif,
      data.date_debut || '',
      data.date_fin || '',
      now
    ]
  );
  return getAbsenceById(res.insertId);
}

async function getAbsenceById(id) {
  const p = await getPool();
  const [rows] = await p.query('SELECT * FROM pm_absences WHERE id = ?', [id]);
  return rows[0] || null;
}

async function updateAbsenceMessage(id, channelId, messageId) {
  const p = await getPool();
  await p.query('UPDATE pm_absences SET channel_id = ?, message_id = ? WHERE id = ?', [channelId, messageId, id]);
}

async function acknowledgeAbsence(id, ackedBy, ackedByName) {
  const p = await getPool();
  const now = Date.now();
  await p.query(
    `UPDATE pm_absences
     SET status = 'PRISE_EN_COMPTE', acked_by = ?, acked_by_name = ?, acked_at = ?
     WHERE id = ? AND status = 'EN_ATTENTE'`,
    [ackedBy, ackedByName, now, id]
  );
  return getAbsenceById(id);
}

module.exports = {
  getPool,
  initDatabase,
  getConfig,
  setConfig,
  getOfficerByUsername,
  getOfficerByDiscordId,
  getOfficerByRio,
  getAllOfficers,
  saveOfficer,
  deleteOfficer,
  getActiveServiceByRio,
  getActiveServiceByDiscordId,
  getAllActiveServices,
  startService,
  togglePauseService,
  stopService,
  getCsuState,
  setCsuOperator,
  clearCsuOperator,
  getAllPatrols,
  createPatrol,
  deletePatrol,
  assignOfficerToPatrol,
  unassignOfficerFromPatrol,
  setOfficerPatrol,
  ensureOfficerRio,
  getRecentServiceReports,
  getAllCasiers,
  getCasierByIdOrNo,
  createAbsence,
  getAbsenceById,
  updateAbsenceMessage,
  acknowledgeAbsence
};
