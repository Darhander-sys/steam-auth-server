require('dotenv').config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const redis = require("redis");

// ===== ПРАВИЛЬНЫЙ ИМПОРТ ДЛЯ connect-redis@5 =====
const RedisStore = require("connect-redis")(session);

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || "/";
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

console.log('🔍 Проверка переменных:');
console.log('STEAM_API_KEY:', STEAM_API_KEY ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('SESSION_SECRET:', SESSION_SECRET ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('REDIS_URL:', process.env.REDIS_URL ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('FRONTEND_URL:', FRONTEND_URL);

if (!STEAM_API_KEY) {
    console.error("❌ Missing STEAM_API_KEY.");
    process.exit(1);
}
if (!SESSION_SECRET) {
    console.error("❌ Missing SESSION_SECRET.");
    process.exit(1);
}

const app = express();

// ===== CORS =====
if (CORS_ORIGIN) {
    const cors = require("cors");
    app.use(cors({
        origin: CORS_ORIGIN,
        credentials: true,
    }));
}

app.use(express.json());

// ===== REDIS CLIENT =====
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err.message));
redisClient.on('connect', () => console.log('✅ Redis подключен'));

// ===== СЕССИИ С REDIS =====
app.use(
    session({
        store: new RedisStore({ client: redisClient }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: IS_PRODUCTION,
            maxAge: 1000 * 60 * 60 * 24 * 7,
        },
    })
);

// ===== PASSPORT =====
app.use(passport.initialize());
app.use(passport.session());

function normalizeSteamUser(profile) {
    const photos = Array.isArray(profile?.photos) ? profile.photos : [];
    const avatar =
        photos.find((p) => p?.value?.includes("full"))?.value ||
        photos.find((p) => p?.value?.includes("medium"))?.value ||
        photos.find((p) => p?.value)?.value ||
        "";

    return {
        id: String(profile?.id || ""),
        name: String(profile?.displayName || "Steam User"),
        avatar,
        balance: 0,
    };
}

passport.use(new SteamStrategy({
    returnURL: `${BASE_URL}/api/auth/steam/return`,
    realm: BASE_URL,
    apiKey: STEAM_API_KEY,
}, (identifier, profile, done) => {
    try {
        return done(null, normalizeSteamUser(profile));
    } catch (error) {
        return done(error);
    }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ===== МАРШРУТЫ =====
app.get("/api/auth/steam", passport.authenticate("steam", { failureRedirect: "/" }));

app.get("/api/auth/steam/return",
    passport.authenticate("steam", { failureRedirect: "/" }),
    (req, res) => {
        console.log('✅ Успешный вход:', req.user?.name);
        res.redirect(FRONTEND_URL);
    }
);

app.get("/api/auth/me", (req, res) => {
    if (!req.isAuthenticated?.()) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    return res.json(req.user);
});

app.get("/api/auth/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        req.session.destroy((err) => {
            if (err) return next(err);
            res.json({ success: true });
        });
    });
});

app.post("/api/auth/logout", (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        req.session.destroy((err) => {
            if (err) return next(err);
            res.json({ success: true });
        });
    });
});

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
    console.error("❌ Server error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Internal server error" });
});

// ===== ЗАПУСК =====
async function startServer() {
    try {
        await redisClient.connect();
        console.log('✅ Redis готов к работе');

        app.listen(PORT, () => {
            console.log(`✅ Steam auth server listening on ${BASE_URL} (port ${PORT})`);
            console.log(`🔗 Steam login: ${BASE_URL}/api/auth/steam`);
            console.log(`🏥 Health check: ${BASE_URL}/api/health`);
        });
    } catch (error) {
        console.error('❌ Ошибка подключения к Redis:', error.message);
        console.log('⚠️ Сервер запускается БЕЗ Redis (сессии в памяти)');

        app.listen(PORT, () => {
            console.log(`⚠️ Сервер запущен БЕЗ Redis (порт ${PORT})`);
            console.log(`🔗 Steam login: ${BASE_URL}/api/auth/steam`);
        });
    }
}

startServer();