// ПЕРВАЯ СТРОКА — загрузка переменных из .env
require('dotenv').config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const { Pool } = require("pg");
const connectPgSimple = require("connect-pg-simple");

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || "/";
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const DATABASE_URL = process.env.DATABASE_URL;

console.log('🔍 Проверка переменных:');
console.log('STEAM_API_KEY:', STEAM_API_KEY ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('SESSION_SECRET:', SESSION_SECRET ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('DATABASE_URL:', DATABASE_URL ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('FRONTEND_URL:', FRONTEND_URL);

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

if (CORS_ORIGIN) {
    const cors = require("cors");
    app.use(cors({
        origin: CORS_ORIGIN,
        credentials: true,
    }));
}

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

// ===== СЕССИИ В POSTGRESQL =====
app.use(
    session({
        store: new pgSession({
            pool: pool,
            tableName: "session",
        }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: false,
            maxAge: 1000 * 60 * 60 * 24 * 7,
        },
    })
);

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

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

// =======================================================
//  МАРШРУТЫ
// =======================================================

app.get("/api/auth/steam", passport.authenticate("steam", { failureRedirect: "/" }));

app.get(
    "/api/auth/steam/return",
    passport.authenticate("steam", {
        failureRedirect: "/",
        successRedirect: FRONTEND_URL,
    })
);

app.get("/api/auth/me", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    return res.json(req.user);
});

function logoutHandler(req, res, next) {
    req.logout(function onLogout(logoutErr) {
        if (logoutErr) return next(logoutErr);

        req.session.destroy(function onDestroy(sessionErr) {
            if (sessionErr) return next(sessionErr);

            const cookieName = req.session?.cookie?.name || "connect.sid";
            res.clearCookie(cookieName, {
                httpOnly: true,
                sameSite: "lax",
                secure: false,
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

// =======================================================
//  ОБРАБОТКА ОШИБОК
// =======================================================

app.use((req, res) => {
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
        });
    } catch (error) {
        console.error('❌ Критическая ошибка:', error);
        process.exit(1);
    }
}

startServer();