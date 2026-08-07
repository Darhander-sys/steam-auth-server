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
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const DATABASE_URL = process.env.DATABASE_URL;

// Определяем окружение
const isProduction = process.env.NODE_ENV === 'production';

console.log('🔍 Проверка переменных:');
console.log('STEAM_API_KEY:', STEAM_API_KEY ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('SESSION_SECRET:', SESSION_SECRET ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('DATABASE_URL:', DATABASE_URL ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('FRONTEND_URL:', FRONTEND_URL);
console.log('CORS_ORIGIN:', CORS_ORIGIN);
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('isProduction:', isProduction);

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

// ===== ЛОГИРОВАНИЕ ВСЕХ ЗАПРОСОВ =====
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    console.log(`  - Origin: ${req.headers.origin || 'нет'}`);
    console.log(`  - Cookie: ${req.headers.cookie ? '✅ есть' : '❌ нет'}`);
    next();
});

// ===== CORS =====
app.use(cors({
    origin: function (origin, callback) {
        // Разрешаем запросы без origin (например, из Postman)
        if (!origin) {
            return callback(null, true);
        }
        
        // Список разрешённых доменов
        const allowedOrigins = [
            FRONTEND_URL,
            CORS_ORIGIN,
            'http://localhost:5173',
            'http://localhost:3000',
            'http://localhost:3001',
            'https://adored-monstera-794345.framer.app',
        ];
        
        // Разрешаем все домены на framer.app и railway.app
        if (origin.includes('framer.app') || origin.includes('railway.app') || allowedOrigins.includes(origin)) {
            console.log('✅ CORS разрешён для:', origin);
            callback(null, true);
        } else {
            console.log('❌ Заблокирован CORS запрос с:', origin);
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
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const pgSession = connectPgSimple(session);

// ===== ФУНКЦИЯ ДЛЯ СОЗДАНИЯ ТАБЛИЦЫ СЕССИЙ =====
async function createSessionTable() {
    try {
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
        console.log('✅ Таблица session создана или уже существует');
    } catch (error) {
        console.error('❌ Ошибка создания таблицы session:', error.message);
        throw error;
    }
}

// ===== СЕССИИ =====
const sessionMiddleware = session({
    store: new pgSession({
        pool: pool,
        tableName: "session",
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "none",  // Важно для разных доменов
        secure: true,       // Важно для HTTPS
        domain: ".railway.app",  // Точка в начале важна!
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
    },
});

app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

function normalizeSteamUser(profile) {
    const photos = Array.isArray(profile?.photos) ? profile.photos : [];
    const avatar =
        photos.find((p) => p && typeof p.value === "string" && p.value.includes("full"))?.value ||
        photos.find((p) => p && typeof p.value === "string" && p.value.includes("medium"))?.value ||
        photos.find((p) => p && typeof p.value === "string" && p.value)?.value ||
        "";

    return {
        id: String(profile?.id || ""),
        name: String(profile?.displayName || "Steam User"),
        avatar,
        balance: 0,
    };
}

passport.use(
    new SteamStrategy(
        {
            returnURL: `${BASE_URL}/api/auth/steam/return`,
            realm: BASE_URL,
            apiKey: STEAM_API_KEY,
        },
        function verify(identifier, profile, done) {
            try {
                const user = normalizeSteamUser(profile);
                return done(null, user);
            } catch (error) {
                return done(error);
            }
        }
    )
);

// ===== СЕРИАЛИЗАЦИЯ =====
passport.serializeUser((user, done) => {
    console.log('🔍 Сериализация пользователя с ID:', user.id);
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    console.log('🔍 Десериализация пользователя с ID:', id);
    try {
        // TODO: Здесь нужно получить пользователя из БД
        const user = {
            id: id,
            name: 'Steam User',
            avatar: 'https://avatars.steamstatic.com/...',
            balance: 0
        };
        console.log('✅ Пользователь десериализован:', user.id);
        done(null, user);
    } catch (error) {
        console.error('❌ Ошибка десериализации:', error);
        done(error);
    }
});

// =======================================================
//  МАРШРУТЫ
// =======================================================

app.get("/api/auth/steam", passport.authenticate("steam", { failureRedirect: "/" }));

app.get(
    "/api/auth/steam/return",
    passport.authenticate("steam", { failureRedirect: "/" }),
    (req, res) => {
        console.log('✅ Успешный вход!');
        console.log('  - User:', req.user?.name);
        console.log('  - ID:', req.user?.id);
        console.log('  - Session ID:', req.session.id);
        
        // Сохраняем сессию и редиректим
        req.session.save((err) => {
            if (err) {
                console.error('❌ Ошибка сохранения сессии:', err);
                return res.redirect(FRONTEND_URL + '?error=session_error');
            }
            
            console.log('✅ Сессия сохранена, редирект на:', FRONTEND_URL);
            // Редиректим на FRONTEND_URL (ваш Framer сайт)
            res.redirect(FRONTEND_URL);
        });
    }
);

app.get("/api/auth/me", (req, res) => {
    console.log('🔍 Проверка аутентификации:');
    console.log('  - isAuthenticated:', req.isAuthenticated?.());
    console.log('  - Сессия ID:', req.session?.id);
    console.log('  - Пользователь:', req.user?.id || 'нет');
    console.log('  - Cookie:', req.headers.cookie || 'нет');
    
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        console.log('❌ Пользователь не авторизован');
        return res.status(401).json({ error: "Unauthorized" });
    }
    console.log('✅ Пользователь авторизован:', req.user.name);
    return res.json(req.user);
});

function logoutHandler(req, res, next) {
    req.logout(function onLogout(logoutErr) {
        if (logoutErr) return next(logoutErr);

        req.session.destroy(function onDestroy(sessionErr) {
            if (sessionErr) return next(sessionErr);

            res.clearCookie('connect.sid', {
                httpOnly: true,
                sameSite: "none",
                secure: true,
                domain: ".railway.app",
            });
            return res.json({ success: true });
        });
    });
}

app.get("/api/auth/logout", logoutHandler);
app.post("/api/auth/logout", logoutHandler);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((req, res) => {
    console.log(`❌ 404: ${req.method} ${req.path}`);
    res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, _next) => {
    console.error("❌ Server error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
});

// =======================================================
//  ЗАПУСК СЕРВЕРА
// =======================================================

async function startServer() {
    try {
        await createSessionTable();

        app.listen(PORT, () => {
            console.log(`✅ Steam auth server listening on ${BASE_URL} (port ${PORT})`);
            console.log(`🔗 Steam login: ${BASE_URL}/api/auth/steam`);
            console.log(`🏥 Health check: ${BASE_URL}/api/health`);
            console.log(`🌐 Режим: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
            console.log(`🔗 Фронтенд: ${FRONTEND_URL}`);
        });
    } catch (error) {
        console.error('❌ Критическая ошибка:', error);
        process.exit(1);
    }
}

startServer();