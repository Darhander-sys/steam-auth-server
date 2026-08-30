// ПЕРВАЯ СТРОКА — загрузка переменных из .env
require('dotenv').config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const { Pool } = require("pg");
const connectPgSimple = require("connect-pg-simple");
const cors = require("cors");

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const DATABASE_URL = process.env.DATABASE_URL;

console.log('🚀 ЗАПУСК СЕРВЕРА');
console.log('FRONTEND_URL:', FRONTEND_URL);
console.log('BASE_URL:', BASE_URL);

if (!STEAM_API_KEY) {
    console.error("❌ Missing STEAM_API_KEY.");
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error("❌ Missing SESSION_SECRET.");
    process.exit(1);
}
if (!DATABASE_URL) {
    console.error("❌ Missing DATABASE_URL.");
    process.exit(1);
}

const app = express();

// ===== ЛОГИРОВАНИЕ =====
app.use((req, res, next) => {
    console.log(`\n📥 ${req.method} ${req.path}`);
    console.log(`  Cookie: ${req.headers.cookie || 'нет'}`);
    if (req.session) {
        console.log(`  Session ID: ${req.session.id}`);
        console.log(`  Session Passport: ${JSON.stringify(req.session.passport || 'нет')}`);
    }
    next();
});

// ===== CORS =====
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowed = [
            'https://cs2dep.online',
            'https://www.cs2dep.online',
            'https://api.cs2dep.online',
            'http://localhost:5173',
            'http://localhost:3000',
        ];
        
        if (origin.includes('framer.app') || 
            origin.includes('framercanvas.com') || 
            origin.includes('framer.work') ||
            origin.includes('framercanvas.net')) {
            console.log('✅ CORS разрешён для Framer:', origin);
            return callback(null, true);
        }
        
        if (allowed.includes(origin) || origin.includes('railway.app')) {
            console.log('✅ CORS разрешён для:', origin);
            return callback(null, true);
        }
        
        console.log('❌ CORS заблокирован для:', origin);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'Accept', 'Set-Cookie'],
}));

app.use(express.json());

// ===== ПОДКЛЮЧЕНИЕ К POSTGRESQL =====
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const pgSession = connectPgSimple(session);

// ============================================================
//  ⬇️⬇️⬇️ СЕССИИ (НОВЫЙ БЛОК) ⬇️⬇️⬇️
// ============================================================
const sessionStore = new pgSession({
    pool: pool,
    tableName: "session",
    createTableIfMissing: true,
});

app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: true,
        domain: ".cs2dep.online",
        maxAge: 1000 * 60 * 60 * 24 * 7,
    },
    name: 'connect.sid',
    rolling: true,
}));
// ============================================================

// ============================================================
//  ⬇️⬇️⬇️ MIDDLEWARE ДЛЯ ЛОГИРОВАНИЯ СЕССИИ ⬇️⬇️⬇️
// ============================================================
app.use((req, res, next) => {
    console.log('🔍 СЕССИЯ:');
    console.log('  Cookie ID:', req.headers.cookie?.match(/connect\.sid=([^;]+)/)?.[1] || 'нет');
    console.log('  Session ID:', req.session?.id || 'нет');
    console.log('  Session Passport:', JSON.stringify(req.session?.passport || 'нет'));
    console.log('  Session Store:', req.session?.store ? 'есть' : 'нет');
    next();
});
// ============================================================

app.use(passport.initialize());
app.use(passport.session());

// ===== STEAM STRATEGY =====
passport.use(new SteamStrategy(
    {
        returnURL: `${BASE_URL}/api/auth/steam/return`,
        realm: BASE_URL,
        apiKey: STEAM_API_KEY,
    },
    function(identifier, profile, done) {
        console.log('✅ Steam вернул профиль!');
        console.log('  ID:', profile.id);
        console.log('  Name:', profile.displayName);
        
        const user = {
            id: profile.id,
            name: profile.displayName || 'Steam User',
            avatar: profile.photos?.[0]?.value || '',
            balance: 0
        };
        
        pool.query(
            `INSERT INTO users (id, name, avatar, balance) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (id) 
             DO UPDATE SET name = $2, avatar = $3`,
            [user.id, user.name, user.avatar, user.balance]
        ).then(() => {
            console.log('✅ Пользователь сохранён в БД');
        }).catch(err => {
            console.error('❌ Ошибка сохранения в БД:', err);
        });
        
        return done(null, user);
    }
));

// ===== СЕРИАЛИЗАЦИЯ =====
passport.serializeUser((user, done) => {
    console.log('🔒 Сериализация:', user.id);
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    console.log('🔓 Десериализация:', id);
    pool.query('SELECT * FROM users WHERE id = $1', [id])
        .then(result => {
            if (result.rows.length === 0) {
                console.log('❌ Пользователь не найден');
                return done(null, null);
            }
            console.log('✅ Пользователь найден:', result.rows[0].name);
            done(null, result.rows[0]);
        })
        .catch(err => {
            console.error('❌ Ошибка десериализации:', err);
            done(err);
        });
});

// =======================================================
//  МАРШРУТЫ АВТОРИЗАЦИИ
// =======================================================

app.get("/api/auth/steam", 
    (req, res, next) => {
        console.log('🔄 Начало авторизации');
        next();
    },
    passport.authenticate("steam")
);

// ============================================================
//  ⬇️⬇️⬇️ МАРШРУТ /api/auth/steam/return (НОВЫЙ) ⬇️⬇️⬇️
// ============================================================
app.get("/api/auth/steam/return",
    (req, res, next) => {
        console.log('🔄 Возврат от Steam');
        console.log('  Query:', req.query);
        console.log('  Session ID до:', req.session?.id);
        next();
    },
    passport.authenticate("steam", { 
        failureRedirect: "/",
        failureMessage: true 
    }),
    (req, res) => {
        console.log('🎉 АУТЕНТИФИКАЦИЯ УСПЕШНА!');
        console.log('  User ID:', req.user?.id);
        console.log('  User Name:', req.user?.name);
        console.log('  Session ID:', req.session.id);
        console.log('  Session Passport:', JSON.stringify(req.session.passport));
        
        // Сохраняем сессию ПЕРЕД установкой куки
        req.session.save((err) => {
            if (err) {
                console.error('❌ Ошибка сохранения сессии:', err);
                return res.redirect(FRONTEND_URL + '?error=session');
            }
            
            console.log('✅ Сессия сохранена с ID:', req.session.id);
            
            // Теперь устанавливаем куку ПОСЛЕ сохранения
            res.cookie('connect.sid', req.session.id, {
                httpOnly: true,
                secure: true,
                sameSite: 'lax',
                domain: '.cs2dep.online',
                maxAge: 1000 * 60 * 60 * 24 * 7,
                path: '/'
            });
            console.log('🍪 Кука установлена с ID:', req.session.id);
            
            // Проверяем в БД
            pool.query('SELECT * FROM "session" WHERE sid = $1', [req.session.id])
                .then(result => {
                    console.log('  Сессия в БД:', result.rows.length > 0 ? '✅ есть' : '❌ нет');
                })
                .catch(err => console.error('  Ошибка проверки БД:', err));
            
            console.log('🔗 Редирект на:', FRONTEND_URL);
            res.redirect(FRONTEND_URL);
        });
    }
);
// ============================================================

app.get("/api/auth/me", (req, res) => {
    console.log('🔍 /api/auth/me');
    console.log('  isAuthenticated:', req.isAuthenticated?.());
    console.log('  req.user:', req.user?.id || 'нет');
    console.log('  session.passport:', JSON.stringify(req.session?.passport || 'нет'));
    
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        console.log('❌ НЕ АВТОРИЗОВАН');
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    console.log('✅ АВТОРИЗОВАН:', req.user.name);
    res.json(req.user);
});

app.get("/api/auth/check-session", (req, res) => {
    console.log('🔍 /api/auth/check-session');
    console.log('  session.id:', req.session?.id);
    console.log('  session.passport:', JSON.stringify(req.session?.passport || 'нет'));
    console.log('  isAuthenticated:', req.isAuthenticated?.());
    console.log('  req.user:', req.user?.id || 'нет');
    
    res.json({
        sessionId: req.session?.id || 'нет',
        isAuthenticated: req.isAuthenticated?.() || false,
        user: req.user ? { id: req.user.id, name: req.user.name } : null,
        passportUser: req.session?.passport?.user || 'нет',
        cookie: req.headers.cookie || 'нет'
    });
});

app.post("/api/auth/logout", (req, res) => {
    console.log('🚪 Выход');
    req.logout((err) => {
        if (err) return res.status(500).json({ error: err.message });
        req.session.destroy((err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.clearCookie('connect.sid', {
                httpOnly: true,
                sameSite: "lax",
                secure: true,
                domain: ".cs2dep.online",
            });
            res.json({ success: true });
        });
    });
});

// =======================================================
//  API ДЛЯ РАБОТЫ С КЕЙСАМИ
// =======================================================

app.get("/api/cases", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, name, price, image, is_active 
             FROM cases 
             WHERE is_active = true 
             ORDER BY id`
        );
        res.json(result.rows);
    } catch (error) {
        console.error("❌ Ошибка получения кейсов:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/cases/:id/items", async (req, res) => {
    try {
        const caseId = req.params.id;
        const result = await pool.query(
            `SELECT id, name, image, rarity, chance 
             FROM case_items 
             WHERE case_id = $1 
             ORDER BY chance DESC`,
            [caseId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("❌ Ошибка получения предметов:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/api/cases/:id/open", async (req, res) => {
    try {
        if (!req.isAuthenticated || !req.isAuthenticated()) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const userId = req.user.id;
        const caseId = parseInt(req.params.id);

        const caseResult = await pool.query(
            `SELECT id, name, price FROM cases WHERE id = $1 AND is_active = true`,
            [caseId]
        );

        if (caseResult.rows.length === 0) {
            return res.status(404).json({ error: "Case not found or inactive" });
        }

        const caseData = caseResult.rows[0];
        const price = parseFloat(caseData.price);

        const userResult = await pool.query(
            `SELECT balance FROM users WHERE id = $1`,
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const currentBalance = parseFloat(userResult.rows[0].balance);

        if (currentBalance < price) {
            return res.status(400).json({ 
                error: "Insufficient balance", 
                balance: currentBalance,
                required: price
            });
        }

        const itemsResult = await pool.query(
            `SELECT id, name, image, rarity, chance 
             FROM case_items 
             WHERE case_id = $1`,
            [caseId]
        );

        if (itemsResult.rows.length === 0) {
            return res.status(404).json({ error: "No items in this case" });
        }

        const items = itemsResult.rows;
        const random = Math.random();
        let cumulative = 0;
        let selectedItem = null;

        for (const item of items) {
            cumulative += parseFloat(item.chance);
            if (random <= cumulative) {
                selectedItem = item;
                break;
            }
        }

        if (!selectedItem) {
            selectedItem = items[items.length - 1];
        }

        const newBalance = currentBalance - price;
        await pool.query(
            `UPDATE users SET balance = $1 WHERE id = $2`,
            [newBalance, userId]
        );

        await pool.query(
            `INSERT INTO user_inventory (user_id, item_name, item_image, rarity) 
             VALUES ($1, $2, $3, $4)`,
            [userId, selectedItem.name, selectedItem.image, selectedItem.rarity]
        );

        await pool.query(
            `INSERT INTO user_cases_history (user_id, case_id, item_id) 
             VALUES ($1, $2, $3)`,
            [userId, caseId, selectedItem.id]
        );

        res.json({
            success: true,
            case: caseData.name,
            item: {
                id: selectedItem.id,
                name: selectedItem.name,
                image: selectedItem.image,
                rarity: selectedItem.rarity
            },
            balance: newBalance,
            price: price
        });

    } catch (error) {
        console.error("❌ Ошибка открытия кейса:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/user/inventory", async (req, res) => {
    try {
        if (!req.isAuthenticated || !req.isAuthenticated()) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const userId = req.user.id;
        const result = await pool.query(
            `SELECT id, item_name, item_image, rarity, received_at 
             FROM user_inventory 
             WHERE user_id = $1 
             ORDER BY received_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (error) {
        console.error("❌ Ошибка получения инвентаря:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/user/balance", async (req, res) => {
    try {
        if (!req.isAuthenticated || !req.isAuthenticated()) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const userId = req.user.id;
        const result = await pool.query(
            `SELECT balance FROM users WHERE id = $1`,
            [userId]
        );
        res.json({ balance: parseFloat(result.rows[0].balance) });
    } catch (error) {
        console.error("❌ Ошибка получения баланса:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// =======================================================
//  HEALTH CHECK
// =======================================================

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// =======================================================
//  ОБРАБОТКА ОШИБОК
// =======================================================

app.use((req, res) => {
    console.log(`❌ 404: ${req.method} ${req.path}`);
    res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
    console.error("❌ Server error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message });
});

// =======================================================
//  ЗАПУСК СЕРВЕРА
// =======================================================

async function startServer() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                avatar VARCHAR(500),
                balance DECIMAL(10, 2) DEFAULT 0
            );
        `);
        console.log('✅ Таблица users готова');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid" varchar NOT NULL,
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL,
                CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
        `);
        console.log('✅ Таблица session готова');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cases (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                image VARCHAR(500),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Таблица cases готова');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS case_items (
                id SERIAL PRIMARY KEY,
                case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                image VARCHAR(500),
                rarity VARCHAR(50) NOT NULL,
                chance DECIMAL(5, 4) NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Таблица case_items готова');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_inventory (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
                item_name VARCHAR(255) NOT NULL,
                item_image VARCHAR(500),
                rarity VARCHAR(50) NOT NULL,
                received_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Таблица user_inventory готова');
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_cases_history (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
                case_id INTEGER REFERENCES cases(id),
                item_id INTEGER REFERENCES case_items(id),
                opened_at TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log('✅ Таблица user_cases_history готова');
        
        app.listen(PORT, () => {
            console.log(`✅ Сервер запущен на ${BASE_URL}`);
            console.log(`🔗 Steam: ${BASE_URL}/api/auth/steam`);
            console.log(`🔗 Фронтенд: ${FRONTEND_URL}`);
            console.log(`🔗 Кейсы: ${BASE_URL}/api/cases`);
        });
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
        process.exit(1);
    }
}

startServer();