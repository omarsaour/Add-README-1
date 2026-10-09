const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");

const APK_DIR = path.join(UPLOADS_DIR, "apks");
const ICON_DIR = path.join(UPLOADS_DIR, "icons");
const SCREENSHOT_DIR = path.join(UPLOADS_DIR, "screenshots");

for (const dir of [DATA_DIR, APK_DIR, ICON_DIR, SCREENSHOT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DB_FILE = path.join(DATA_DIR, "db.json");
const APPS_FILE = path.join(DATA_DIR, "apps.json");

function now() {
  return new Date().toISOString();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashPassword(password, salt = randomToken(16)) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, original] = String(stored).split(":");
    if (!salt || !original) return false;

    const hash = crypto.scryptSync(password, salt, 64).toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(original, "hex")
    );
  } catch {
    return false;
  }
}

function emptyDb() {
  return {
    nextUserId: 1000,
    nextRequestId: 1,
    users: [],
    sessions: [],
    subscriptions: [],
    creator_subscriptions: [],
    coin_transactions: [],
    creator_coin_transactions: [],
    daily_rewards: [],
    publish_requests: []
  };
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const db = emptyDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
    return db;
  }

  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return {
      ...emptyDb(),
      ...db,
      users: db.users || [],
      sessions: db.sessions || [],
      subscriptions: db.subscriptions || [],
      creator_subscriptions: db.creator_subscriptions || [],
      coin_transactions: db.coin_transactions || [],
      creator_coin_transactions: db.creator_coin_transactions || [],
      daily_rewards: db.daily_rewards || [],
      publish_requests: db.publish_requests || []
    };
  } catch {
    throw new Error("db.json is invalid");
  }
}

function saveDb(db) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

function loadApps() {
  if (!fs.existsSync(APPS_FILE)) {
    fs.writeFileSync(APPS_FILE, "[]", "utf8");
  }

  try {
    return JSON.parse(fs.readFileSync(APPS_FILE, "utf8"));
  } catch {
    throw new Error("apps.json is invalid");
  }
}

function saveApps(apps) {
  const tmp = APPS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(apps, null, 2), "utf8");
  fs.renameSync(tmp, APPS_FILE);
}

function cleanUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    coins: user.coins || 0,
    creator_coins: user.creator_coins || 0,
    created_at: user.created_at
  };
}

function findUser(db, identity) {
  const value = String(identity || "").trim().toLowerCase();

  return db.users.find(
    u =>
      String(u.email).toLowerCase() === value ||
      String(u.username).toLowerCase() === value
  );
}

function getUserById(db, id) {
  return db.users.find(u => Number(u.id) === Number(id));
}

function sessionUser(req) {
  const token = String(req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!token) return null;

  const db = loadDb();

  const session = db.sessions.find(
    s => s.token === token && new Date(s.expires_at).getTime() > Date.now()
  );

  if (!session) return null;

  const user = getUserById(db, session.user_id);
  if (!user) return null;

  return {
    db,
    user,
    session
  };
}

function requireAuth(req, res, next) {
  const auth = sessionUser(req);

  if (!auth) {
    return res.status(401).json({
      success: false,
      error: "invalid_session"
    });
  }

  req.auth = auth;
  next();
}

function requireAdmin(req, res, next) {
  const auth = sessionUser(req);

  if (!auth) {
    return res.status(401).json({
      success: false,
      error: "invalid_session"
    });
  }

  if (auth.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "admin_only"
    });
  }

  req.auth = auth;
  next();
}

function normalizeText(value, max = 10000) {
  return String(value ?? "").trim().slice(0, max);
}

function validAmount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function planInfo(plan) {
  const plans = {
    "جيد": {
      price: 100,
      days: 7,
      rank: 1
    },
    "جيد جداً": {
      price: 500,
      days: 30,
      rank: 2
    },
    "ممتاز": {
      price: 10000,
      days: 365,
      rank: 3
    }
  };

  return plans[plan] || null;
}

function activeSubscription(db, userId, creator = false) {
  const list = creator
    ? db.creator_subscriptions
    : db.subscriptions;

  const current = list
    .filter(
      s =>
        Number(s.user_id) === Number(userId) &&
        s.active === true &&
        new Date(s.expires_at).getTime() > Date.now()
    )
    .sort(
      (a, b) =>
        new Date(b.expires_at).getTime() -
        new Date(a.expires_at).getTime()
    );

  return current[0] || null;
}

function deactivateSubscriptions(db, userId, creator = false) {
  const list = creator
    ? db.creator_subscriptions
    : db.subscriptions;

  for (const sub of list) {
    if (Number(sub.user_id) === Number(userId)) {
      sub.active = false;
    }
  }
}

function rewardForSubscription(sub) {
  if (!sub) return 0;

  if (sub.plan === "ممتاز") return 75;
  if (sub.plan === "جيد جداً") return 10;

  return 0;
}

function ensureAdmin() {
  const db = loadDb();

  let admin = db.users.find(u => u.role === "admin");

  if (admin) {
    saveDb(db);
    return {
      created: false,
      password: null
    };
  }

  const password =
    process.env.OMAR_ADMIN_PASSWORD ||
    "OmarAdmin-" + randomToken(8);

  admin = {
    id: 1,
    username: "ADMIN",
    email: "admin@omarstore.local",
    password_hash: hashPassword(password),
    role: "admin",
    coins: 1000000,
    creator_coins: 1000000,
    created_at: now()
  };

  db.users.push(admin);
  saveDb(db);

  return {
    created: true,
    password
  };
}

const adminSetup = ensureAdmin();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "apk") return cb(null, APK_DIR);
    if (file.fieldname === "icon") return cb(null, ICON_DIR);
    if (file.fieldname === "screenshots") return cb(null, SCREENSHOT_DIR);

    cb(new Error("Unknown file field"));
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();

    const name =
      Date.now() +
      "-" +
      crypto.randomBytes(6).toString("hex") +
      ext;

    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 12
  }
});

app.use(cors({
  origin: true
}));

app.use(express.json({ limit: "2mb" }));

/* =========================================================
   BASIC
========================================================= */

app.get("/", (req, res) => {
  res.json({
    name: "OmarBackend",
    status: "online",
    version: "2.0.0",
    architecture: "central_backend"
  });
});

app.get("/api/health", (req, res) => {
  const db = loadDb();

  res.json({
    success: true,
    status: "healthy",
    version: "2.0.0",
    users: db.users.length,
    apps: loadApps().length,
    time: now()
  });
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/auth/register", (req, res) => {
  try {
    const username = normalizeText(req.body.username, 50);
    const email = normalizeText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !email || password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "username_email_password_required"
      });
    }

    const db = loadDb();

    const duplicate = db.users.find(
      u =>
        String(u.username).toLowerCase() === username.toLowerCase() ||
        String(u.email).toLowerCase() === email
    );

    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: "username_or_email_exists"
      });
    }

    const user = {
      id: db.nextUserId++,
      username,
      email,
      password_hash: hashPassword(password),
      role: "user",
      coins: 0,
      creator_coins: 0,
      created_at: now()
    };

    db.users.push(user);

    const token = randomToken(48);

    db.sessions.push({
      token,
      user_id: user.id,
      created_at: now(),
      expires_at: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString()
    });

    saveDb(db);

    res.status(201).json({
      success: true,
      user: cleanUser(user),
      session_token: token
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const identity = normalizeText(req.body.identity, 150);
    const password = String(req.body.password || "");

    if (!identity || !password) {
      return res.status(400).json({
        success: false,
        error: "identity_password_required"
      });
    }

    const db = loadDb();
    const user = findUser(db, identity);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        success: false,
        error: "invalid_credentials"
      });
    }

    const token = randomToken(48);

    db.sessions = db.sessions.filter(
      s => Number(s.user_id) !== Number(user.id)
    );

    db.sessions.push({
      token,
      user_id: user.id,
      created_at: now(),
      expires_at: new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString()
    });

    saveDb(db);

    res.json({
      success: true,
      user: cleanUser(user),
      session_token: token
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const db = req.auth.db;
  db.sessions = db.sessions.filter(
    s => s.token !== req.auth.session.token
  );
  saveDb(db);

  res.json({
    success: true
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({
    success: true,
    user: cleanUser(req.auth.user)
  });
});

/* =========================================================
   BALANCES
========================================================= */

app.get("/api/account/balance", requireAuth, (req, res) => {
  res.json({
    success: true,
    coins: req.auth.user.coins || 0
  });
});

app.get("/api/account/creator-balance", requireAuth, (req, res) => {
  res.json({
    success: true,
    creator_coins: req.auth.user.creator_coins || 0
  });
});

/* =========================================================
   SUBSCRIPTIONS
========================================================= */

app.get("/api/account/subscription", requireAuth, (req, res) => {
  const db = req.auth.db;

  res.json({
    success: true,
    subscription: activeSubscription(
      db,
      req.auth.user.id,
      false
    )
  });
});

app.get("/api/account/creator-subscription", requireAuth, (req, res) => {
  const db = req.auth.db;

  res.json({
    success: true,
    subscription: activeSubscription(
      db,
      req.auth.user.id,
      true
    )
  });
});

/* =========================================================
   STORE UPGRADES
========================================================= */

app.post("/api/account/buy-upgrade", requireAuth, (req, res) => {
  try {
    const plan = normalizeText(req.body.plan, 50);
    const info = planInfo(plan);

    if (!info) {
      return res.status(400).json({
        success: false,
        error: "invalid_plan"
      });
    }

    const db = loadDb();
    const user = getUserById(db, req.auth.user.id);

    const current = activeSubscription(
      db,
      user.id,
      false
    );

    if (current && Number(current.rank) >= Number(info.rank)) {
      return res.status(409).json({
        success: false,
        error: "same_or_lower_plan"
      });
    }

    const before = Number(user.coins || 0);

    if (before < info.price) {
      return res.status(400).json({
        success: false,
        error: "insufficient_coins",
        balance: before,
        required: info.price
      });
    }

    const after = before - info.price;

    deactivateSubscriptions(db, user.id, false);

    user.coins = after;

    const subscription = {
      id: randomToken(12),
      user_id: user.id,
      plan,
      price: info.price,
      rank: info.rank,
      active: true,
      created_at: now(),
      expires_at: new Date(
        Date.now() + info.days * 24 * 60 * 60 * 1000
      ).toISOString()
    };

    db.subscriptions.push(subscription);

    const admin = db.users.find(u => u.role === "admin");
    if (admin) {
      admin.coins = Number(admin.coins || 0) + info.price;
    }

    db.coin_transactions.push({
      id: randomToken(12),
      user_id: user.id,
      type: "buy_upgrade",
      amount: -info.price,
      before,
      after,
      description: `شراء ترقية ${plan}`,
      created_at: now()
    });

    saveDb(db);

    res.json({
      success: true,
      subscription,
      coins: after
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   CREATOR UPGRADES
========================================================= */

app.post("/api/account/buy-creator-upgrade", requireAuth, (req, res) => {
  try {
    const plan = normalizeText(req.body.plan, 50);
    const info = planInfo(plan);

    if (!info) {
      return res.status(400).json({
        success: false,
        error: "invalid_plan"
      });
    }

    const db = loadDb();
    const user = getUserById(db, req.auth.user.id);

    const current = activeSubscription(
      db,
      user.id,
      true
    );

    if (current && Number(current.rank) >= Number(info.rank)) {
      return res.status(409).json({
        success: false,
        error: "same_or_lower_plan"
      });
    }

    const before = Number(user.creator_coins || 0);

    if (before < info.price) {
      return res.status(400).json({
        success: false,
        error: "insufficient_creator_coins",
        balance: before,
        required: info.price
      });
    }

    const after = before - info.price;

    deactivateSubscriptions(db, user.id, true);

    user.creator_coins = after;

    const subscription = {
      id: randomToken(12),
      user_id: user.id,
      plan,
      price: info.price,
      rank: info.rank,
      active: true,
      created_at: now(),
      expires_at: new Date(
        Date.now() + info.days * 24 * 60 * 60 * 1000
      ).toISOString()
    };

    db.creator_subscriptions.push(subscription);

    const admin = db.users.find(u => u.role === "admin");
    if (admin) {
      admin.creator_coins =
        Number(admin.creator_coins || 0) + info.price;
    }

    db.creator_coin_transactions.push({
      id: randomToken(12),
      user_id: user.id,
      type: "buy_creator_upgrade",
      amount: -info.price,
      before,
      after,
      description: `شراء ترقية منشئ ${plan}`,
      created_at: now()
    });

    saveDb(db);

    res.json({
      success: true,
      subscription,
      creator_coins: after
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   DAILY REWARDS
========================================================= */

app.post("/api/account/daily-reward", requireAuth, (req, res) => {
  try {
    const db = req.auth.db;
    const user = getUserById(db, req.auth.user.id);

    const sub = activeSubscription(
      db,
      user.id,
      false
    );

    const reward = rewardForSubscription(sub);

    if (!reward) {
      return res.json({
        success: true,
        claimed: false,
        reward: 0,
        coins: user.coins || 0
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    const already = db.daily_rewards.find(
      r =>
        Number(r.user_id) === Number(user.id) &&
        r.app_type === "store" &&
        r.day === today
    );

    if (already) {
      return res.json({
        success: true,
        claimed: false,
        reward: 0,
        coins: user.coins || 0
      });
    }

    const before = Number(user.coins || 0);
    const after = before + reward;

    user.coins = after;

    db.daily_rewards.push({
      id: randomToken(12),
      user_id: user.id,
      app_type: "store",
      day: today,
      reward,
      created_at: now()
    });

    db.coin_transactions.push({
      id: randomToken(12),
      user_id: user.id,
      type: "daily_reward",
      amount: reward,
      before,
      after,
      description: "مكافأة يومية",
      created_at: now()
    });

    saveDb(db);

    res.json({
      success: true,
      claimed: true,
      reward,
      coins: after
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post(
  "/api/account/creator-daily-reward",
  requireAuth,
  (req, res) => {
    try {
      const db = req.auth.db;
      const user = getUserById(db, req.auth.user.id);

      const sub = activeSubscription(
        db,
        user.id,
        true
      );

      const reward = rewardForSubscription(sub);

      if (!reward) {
        return res.json({
          success: true,
          claimed: false,
          reward: 0,
          creator_coins: user.creator_coins || 0
        });
      }

      const today = new Date().toISOString().slice(0, 10);

      const already = db.daily_rewards.find(
        r =>
          Number(r.user_id) === Number(user.id) &&
          r.app_type === "creator" &&
          r.day === today
      );

      if (already) {
        return res.json({
          success: true,
          claimed: false,
          reward: 0,
          creator_coins: user.creator_coins || 0
        });
      }

      const before = Number(user.creator_coins || 0);
      const after = before + reward;

      user.creator_coins = after;

      db.daily_rewards.push({
        id: randomToken(12),
        user_id: user.id,
        app_type: "creator",
        day: today,
        reward,
        created_at: now()
      });

      db.creator_coin_transactions.push({
        id: randomToken(12),
        user_id: user.id,
        type: "daily_reward",
        amount: reward,
        before,
        after,
        description: "مكافأة منشئ يومية",
        created_at: now()
      });

      saveDb(db);

      res.json({
        success: true,
        claimed: true,
        reward,
        creator_coins: after
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* =========================================================
   CREATOR CHARGE / REFUND
========================================================= */

app.post("/api/account/creator-charge", requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!validAmount(amount)) {
      return res.status(400).json({
        success: false,
        error: "invalid_amount"
      });
    }

    const db = req.auth.db;
    const user = getUserById(db, req.auth.user.id);

    const before = Number(user.creator_coins || 0);

    if (before < amount) {
      return res.status(400).json({
        success: false,
        error: "insufficient_creator_coins",
        balance: before,
        required: amount
      });
    }

    const after = before - amount;

    user.creator_coins = after;

    const admin = db.users.find(u => u.role === "admin");

    if (admin) {
      admin.creator_coins =
        Number(admin.creator_coins || 0) + amount;
    }

    db.creator_coin_transactions.push({
      id: randomToken(12),
      user_id: user.id,
      type: "creator_charge",
      amount: -amount,
      before,
      after,
      description: normalizeText(
        req.body.description || "خصم منشئ",
        200
      ),
      created_at: now()
    });

    saveDb(db);

    res.json({
      success: true,
      creator_coins: after
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/account/creator-refund", requireAuth, (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!validAmount(amount)) {
      return res.status(400).json({
        success: false,
        error: "invalid_amount"
      });
    }

    const db = req.auth.db;
    const user = getUserById(db, req.auth.user.id);
    const admin = db.users.find(u => u.role === "admin");

    if (!admin || Number(admin.creator_coins || 0) < amount) {
      return res.status(400).json({
        success: false,
        error: "admin_creator_balance_insufficient"
      });
    }

    const before = Number(user.creator_coins || 0);
    const after = before + amount;

    user.creator_coins = after;
    admin.creator_coins =
      Number(admin.creator_coins || 0) - amount;

    db.creator_coin_transactions.push({
      id: randomToken(12),
      user_id: user.id,
      type: "creator_refund",
      amount,
      before,
      after,
      description: normalizeText(
        req.body.description || "إرجاع عملات منشئ",
        200
      ),
      created_at: now()
    });

    saveDb(db);

    res.json({
      success: true,
      creator_coins: after
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/* =========================================================
   PUBLIC APP CATALOG
========================================================= */

app.get("/api/apps", (req, res) => {
  res.json(loadApps());
});

app.get("/api/apps/:id", (req, res) => {
  const apps = loadApps();

  const found = apps.find(
    item => String(item.id) === String(req.params.id)
  );

  if (!found) {
    return res.status(404).json({
      success: false,
      error: "app_not_found"
    });
  }

  res.json(found);
});

app.post("/api/apps/:id/download", (req, res) => {
  const apps = loadApps();

  const item = apps.find(
    a => String(a.id) === String(req.params.id)
  );

  if (!item) {
    return res.status(404).json({
      success: false,
      error: "app_not_found"
    });
  }

  item.downloads = Number(item.downloads || 0) + 1;
  item.updated_at = item.updated_at || now();

  saveApps(apps);

  res.json({
    success: true,
    downloads: item.downloads,
    apk_url: item.apk_url
  });
});

/* =========================================================
   ADMIN APP MANAGEMENT
========================================================= */

function appUploadMiddleware(req, res, next) {
  upload.fields([
    { name: "apk", maxCount: 1 },
    { name: "icon", maxCount: 1 },
    { name: "screenshots", maxCount: 10 }
  ])(req, res, err => {
    if (err) {
      return res.status(400).json({
        success: false,
        error: err.message
      });
    }

    next();
  });
}

function makeAppData(req, oldApp = null) {
  const apps = loadApps();
  const files = req.files || {};
  const baseUrl = `${req.protocol}://${req.get("host")}`;

  const packageName =
    normalizeText(
      req.body.package_name ??
      oldApp?.package_name ??
      "",
      200
    );

  if (!packageName) {
    throw new Error("package_name is required");
  }

  const versionCode = Number(
    req.body.version_code ??
    oldApp?.version_code ??
    1
  );

  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error("invalid_version_code");
  }

  if (
    oldApp &&
    Number(versionCode) < Number(oldApp.version_code || 0)
  ) {
    throw new Error("version_downgrade_not_allowed");
  }

  const apk =
    files.apk?.[0]
      ? `${baseUrl}/uploads/apks/${files.apk[0].filename}`
      : (oldApp?.apk_url || null);

  const icon =
    files.icon?.[0]
      ? `${baseUrl}/uploads/icons/${files.icon[0].filename}`
      : (oldApp?.icon_url || null);

  const screenshots =
    files.screenshots?.length
      ? files.screenshots.map(
          file =>
            `${baseUrl}/uploads/screenshots/${file.filename}`
        )
      : (oldApp?.screenshots || []);

  const nextId =
    oldApp?.id ??
    (
      apps.length > 0
        ? Math.max(
            ...apps.map(a => Number(a.id) || 0)
          ) + 1
        : 1
    );

  return {
    id: nextId,
    name: normalizeText(
      req.body.name ?? oldApp?.name ?? "",
      200
    ),
    package_name: packageName,
    description: normalizeText(
      req.body.description ?? oldApp?.description ?? "",
      10000
    ),
    category: normalizeText(
      req.body.category ?? oldApp?.category ?? "",
      100
    ),
    version_name: normalizeText(
      req.body.version_name ?? oldApp?.version_name ?? "",
      100
    ),
    version_code: versionCode,
    changelog: normalizeText(
      req.body.changelog ?? oldApp?.changelog ?? "",
      5000
    ),
    size_mb: Number(
      req.body.size_mb ?? oldApp?.size_mb ?? 0
    ) || 0,
    icon_url: icon,
    apk_url: apk,
    screenshots,
    downloads: Number(oldApp?.downloads || 0),
    status: "published",
    created_at:
      oldApp?.created_at || now(),
    updated_at: now()
  };
}

app.post(
  "/api/apps",
  requireAdmin,
  appUploadMiddleware,
  (req, res) => {
    try {
      const apps = loadApps();
      const packageName = normalizeText(
        req.body.package_name,
        200
      );

      if (!packageName) {
        return res.status(400).json({
          success: false,
          error: "package_name_required"
        });
      }

      if (
        apps.some(
          a =>
            String(a.package_name).toLowerCase() ===
            packageName.toLowerCase()
        )
      ) {
        return res.status(409).json({
          success: false,
          error: "package_name_exists"
        });
      }

      const newApp = makeAppData(req);

      apps.push(newApp);
      saveApps(apps);

      res.status(201).json({
        success: true,
        app: newApp
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.post(
  "/api/apps/sync",
  requireAdmin,
  appUploadMiddleware,
  (req, res) => {
    try {
      const apps = loadApps();

      const packageName = normalizeText(
        req.body.package_name,
        200
      );

      if (!packageName) {
        return res.status(400).json({
          success: false,
          error: "package_name_required"
        });
      }

      const index = apps.findIndex(
        a =>
          String(a.package_name).toLowerCase() ===
          packageName.toLowerCase()
      );

      const oldApp =
        index >= 0 ? apps[index] : null;

      const appData = makeAppData(
        req,
        oldApp
      );

      if (index >= 0) {
        apps[index] = appData;
      } else {
        apps.push(appData);
      }

      saveApps(apps);

      res.status(index >= 0 ? 200 : 201).json({
        success: true,
        updated: index >= 0,
        app: appData
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.delete("/api/apps/:id", requireAdmin, (req, res) => {
  const apps = loadApps();

  const index = apps.findIndex(
    a => String(a.id) === String(req.params.id)
  );

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "app_not_found"
    });
  }

  apps.splice(index, 1);
  saveApps(apps);

  res.json({
    success: true
  });
});

/* =========================================================
   ADMIN COINS
========================================================= */

app.post("/api/admin/add-coins", requireAdmin, (req, res) => {
  try {
    const username = normalizeText(
      req.body.username,
      100
    );

    const amount = Number(req.body.amount);

    if (!username || !validAmount(amount)) {
      return res.status(400).json({
        success: false,
        error: "username_amount_required"
      });
    }

    const db = loadDb();

    const user = db.users.find(
      u =>
        String(u.username).toLowerCase() ===
        username.toLowerCase() &&
        u.role !== "admin"
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "user_not_found"
      });
    }

    const admin = db.users.find(u => u.role === "admin");

    if (Number(admin.coins || 0) < amount) {
      return res.status(400).json({
        success: false,
        error: "admin_balance_insufficient"
      });
    }

    const before = Number(user.coins || 0);
    const after = before + amount;

    user.coins = after;
    admin.coins =
      Number(admin.coins || 0) - amount;

    db.coin_transactions.push({
      id: randomToken(12),
      user_id: user.id,
      type: "admin_add",
      amount,
      before,
      after,
      description: "إضافة من الإدارة",
      created_at: now()
    });

    saveDb(db);

    res.json({
      success: true,
      user: cleanUser(user)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const db = req.auth.db;

  res.json({
    success: true,
    users: db.users
      .filter(u => u.role !== "admin")
      .map(cleanUser)
  });
});

app.get(
  "/api/admin/transactions",
  requireAdmin,
  (req, res) => {
    const db = req.auth.db;

    res.json({
      success: true,
      coins: db.coin_transactions,
      creator_coins:
        db.creator_coin_transactions
    });
  }
);

/* =========================================================
   PUBLISH REQUESTS
========================================================= */

app.post(
  "/api/publish-requests",
  requireAuth,
  (req, res) => {
    try {
      const db = req.auth.db;

      const type = normalizeText(
        req.body.type,
        20
      );

      if (type !== "publish" && type !== "update") {
        return res.status(400).json({
          success: false,
          error: "invalid_request_type"
        });
      }

      const appId =
        req.body.app_id == null
          ? null
          : Number(req.body.app_id);

      if (
        type === "publish" &&
        appId !== null
      ) {
        return res.status(400).json({
          success: false,
          error: "publish_cannot_have_app_id"
        });
      }

      if (type === "update") {
        const apps = loadApps();

        if (
          !appId ||
          !apps.some(
            a => Number(a.id) === appId
          )
        ) {
          return res.status(400).json({
            success: false,
            error: "app_not_found"
          });
        }
      }

      const request = {
        id: db.nextRequestId++,
        user_id: req.auth.user.id,
        type,
        app_id: appId,
        package_name: normalizeText(
          req.body.package_name,
          200
        ),
        name: normalizeText(
          req.body.name,
          200
        ),
        status: "pending",
        created_at: now(),
        updated_at: now()
      };

      db.publish_requests.push(request);
      saveDb(db);

      res.status(201).json({
        success: true,
        request
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.get(
  "/api/publish-requests",
  requireAuth,
  (req, res) => {
    const db = req.auth.db;

    res.json({
      success: true,
      requests: db.publish_requests.filter(
        r =>
          Number(r.user_id) ===
          Number(req.auth.user.id)
      )
    });
  }
);

app.get(
  "/api/admin/publish-requests",
  requireAdmin,
  (req, res) => {
    const db = req.auth.db;

    res.json({
      success: true,
      requests: db.publish_requests
    });
  }
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  "/uploads",
  express.static(UPLOADS_DIR)
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    error: err.message || "server_error"
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("==============================================");
  console.log("        OMAR BACKEND 2.0");
  console.log("        CENTRAL BACKEND ONLINE");
  console.log("==============================================");
  console.log("PORT: " + PORT);
  console.log("Health: http://127.0.0.1:" + PORT + "/api/health");
  console.log("==============================================");

  if (adminSetup.created) {
    console.log("");
    console.log("⚠️ INITIAL ADMIN ACCOUNT");
    console.log("Username: ADMIN");
    console.log("Email: admin@omarstore.local");
    console.log("Password: [hidden]");
    console.log("");
    console.log("احفظ كلمة السر فوراً.");
    console.log("==============================================");
  }

  console.log("");
});
