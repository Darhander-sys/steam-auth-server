// ПЕРВАЯ СТРОКА — загрузка переменных из .env
require('dotenv').config();

const express = require("express")
const session = require("express-session")
const passport = require("passport")
const SteamStrategy = require("passport-steam").Strategy
const redis = require("redis");
const RedisStore = require("connect-redis")(session);

const STEAM_API_KEY = process.env.STEAM_API_KEY
const BASE_URL = process.env.BASE_URL || "http://localhost:3000"
const SESSION_SECRET = process.env.SESSION_SECRET
const PORT = Number(process.env.PORT || 3000)
const FRONTEND_URL = process.env.FRONTEND_URL || "/"
const CORS_ORIGIN = process.env.CORS_ORIGIN
const IS_PRODUCTION = process.env.NODE_ENV === "production"

// ОТЛАДКА: проверяем, что переменные загрузились
console.log('🔍 Проверка переменных:');
console.log('STEAM_API_KEY:', process.env.STEAM_API_KEY ? '✅ ЕСТЬ' : '❌ НЕТ');
console.log('SESSION_SECRET:', process.env.SESSION_SECRET ? '✅ ЕСТЬ' : '❌ НЕТ');

if (!STEAM_API_KEY) {
    console.error(
        "❌ Missing STEAM_API_KEY. Set STEAM_API_KEY in your environment before starting the server."
    )
    process.exit(1)
}

if (!SESSION_SECRET) {
    console.error(
        "❌ Missing SESSION_SECRET. Set SESSION_SECRET in your environment before starting the server."
    )
    process.exit(1)
}

const redisClient = redis.createClient({
  url: process.env.REDIS_URL
});

// ОБЯЗАТЕЛЬНО добавляем эту строку для обработки ошибок соединения
redisClient.on('error', (err) => console.log('Redis Client Error', err));

redisClient.connect().catch((err) => {
    console.error("❌ Redis connection failed:", err.message);
});
const app = express()

if (CORS_ORIGIN) {
    const cors = require("cors")
    app.use(
        cors({
            origin: CORS_ORIGIN,
            credentials: true,
        })
    )
}

app.use(express.json())

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
)

app.use(passport.initialize())
app.use(passport.session())

function normalizeSteamUser(profile) {
    const photos = Array.isArray(profile?.photos) ? profile.photos : []
    const avatar =
        photos.find(
            (p) => p && typeof p.value === "string" && p.value.includes("full")
        )?.value ||
        photos.find(
            (p) =>
                p && typeof p.value === "string" && p.value.includes("medium")
        )?.value ||
        photos.find((p) => p && typeof p.value === "string" && p.value)
            ?.value ||
        ""

    return {
        id: String(profile?.id || ""),
        name: String(profile?.displayName || "Steam User"),
        avatar,
        balance: 0,
    }
}

passport.use(
    new SteamStrategy(
        {
            returnURL: `${BASE_URL}/api/auth/steam/return`,
            realm: BASE_URL,
            apiKey: STEAM_API_KEY,
        },
        function verify(_identifier, profile, done) {
            try {
                const user = normalizeSteamUser(profile)
                return done(null, user)
            } catch (error) {
                return done(error)
            }
        }
    )
)

passport.serializeUser((user, done) => {
    done(null, user)
})

passport.deserializeUser((user, done) => {
    done(null, user)
})

app.get(
    "/api/auth/steam",
    passport.authenticate("steam", { failureRedirect: "/" })
)

app.get(
    "/api/auth/steam/return",
    passport.authenticate("steam", { failureRedirect: "/" }),
    (req, res) => {
        res.redirect(FRONTEND_URL)
    }
)

app.get("/api/auth/me", (req, res) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" })
    }
    return res.json(req.user)
})

function logoutHandler(req, res, next) {
    req.logout(function onLogout(logoutErr) {
        if (logoutErr) return next(logoutErr)

        req.session.destroy(function onDestroy(sessionErr) {
            if (sessionErr) return next(sessionErr)

            const cookieName = req.session?.cookie?.name || "connect.sid"
            res.clearCookie(cookieName, {
                httpOnly: true,
                sameSite: "lax",
                secure: IS_PRODUCTION,
            })
            return res.json({ success: true })
        })
    })
}

app.get("/api/auth/logout", logoutHandler)
app.post("/api/auth/logout", logoutHandler)

// Health check для проверки работоспособности
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.use((req, res) => {
    res.status(404).json({ error: "Not found" })
})

app.use((err, req, res, _next) => {
    console.error("Server error:", err)
    if (res.headersSent) return
    res.status(500).json({ error: "Internal server error" })
})

app.listen(PORT, () => {
    console.log(`✅ Steam auth server listening on ${BASE_URL} (port ${PORT})`)
    console.log(`🔗 Steam login: ${BASE_URL}/api/auth/steam`)
    console.log(`🏥 Health check: ${BASE_URL}/api/health`)
})