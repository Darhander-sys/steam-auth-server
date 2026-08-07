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
        if (origin.includes('framer.app') || origin.includes('railway.app') || origin.includes('localhost')) {
            console.log('✅ CORS разрешён для:', origin);
            callback(null, true);
        } else {
            console.log('❌ CORS заблокирован для:', origin);
            callback(new Error('Not allowed by CORS'));
        }
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

// ===== СЕССИИ =====
app.use(session({
    store: new pgSession({
        pool: pool,
        tableName: "session",
        createTableIfMissing: true,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        domain: ".railway.app",
        maxAge: 1000 * 60 * 60 * 24 * 7,
    },
}));

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
        
        // Сохраняем пользователя в БД
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
//  МАРШРУТЫ
// =======================================================

app.get("/api/auth/steam", 
    (req, res, next) => {
        console.log('🔄 Начало авторизации');
        next();
    },
    passport.authenticate("steam")
);

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
        
        // ПРИНУДИТЕЛЬНО СОХРАНЯЕМ СЕССИЮ
        req.session.save((err) => {
            if (err) {
                console.error('❌ Ошибка сохранения сессии:', err);
                return res.redirect(FRONTEND_URL + '?error=session');
            }
            
            console.log('✅ Сессия сохранена!');
            console.log('  Проверка после сохранения:', JSON.stringify(req.session.passport));
            
            // Проверяем в БД
            pool.query('SELECT * FROM "session" WHERE sid = $1', [req.session.id])
                .then(result => {
                    console.log('  Сессия в БД:', result.rows.length > 0 ? '✅ есть' : '❌ нет');
                    if (result.rows.length > 0) {
                        console.log('  Содержимое сессии:', JSON.stringify(result.rows[0].sess).substring(0, 200));
                    }
                })
                .catch(err => console.error('  Ошибка проверки БД:', err));
            
            console.log('🔗 Редирект на:', FRONTEND_URL);
            res.redirect(FRONTEND_URL);
        });
    }
);

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
                sameSite: "none",
                secure: true,
                domain: ".railway.app",
            });
            res.json({ success: true });
        });
    });
});

app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

// =======================================================
//  ЗАПУСК
// =======================================================

async function startServer() {
    try {
        // Создаём таблицы
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                avatar VARCHAR(500),
                balance INTEGER DEFAULT 0
            );
        `);
        console.log('✅ Таблица users готова');
        
        app.listen(PORT, () => {
            console.log(`✅ Сервер запущен на ${BASE_URL}`);
            console.log(`🔗 Steam: ${BASE_URL}/api/auth/steam`);
            console.log(`🔗 Фронтенд: ${FRONTEND_URL}`);
        });
    } catch (error) {
        console.error('❌ Ошибка:', error);
        process.exit(1);
    }
}

startServer();