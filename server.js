```javascript
// =======================================================
// ЗАГРУЗКА ENV
// =======================================================
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SteamStrategy = require("passport-steam").Strategy;
const { Pool } = require("pg");
const connectPgSimple = require("connect-pg-simple");
const cors = require("cors");

// =======================================================
// CONFIG
// =======================================================
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const FRONTEND_URL =
    process.env.FRONTEND_URL || "http://localhost:5173";
const SESSION_SECRET = process.env.SESSION_SECRET;
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

console.log("🚀 ЗАПУСК СЕРВЕРА");
console.log("FRONTEND_URL:", FRONTEND_URL);
console.log("BASE_URL:", BASE_URL);

// =======================================================
// ENV CHECK
// =======================================================
if (!STEAM_API_KEY) {
    console.error("❌ Missing STEAM_API_KEY");
    process.exit(1);
}

if (!SESSION_SECRET) {
    console.error("❌ Missing SESSION_SECRET");
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error("❌ Missing DATABASE_URL");
    process.exit(1);
}

// =======================================================
// APP
// =======================================================
const app = express();

// Railway / reverse proxy
app.set("trust proxy", 1);

// =======================================================
// CORS
// =======================================================
app.use(
    cors({
        origin: function (origin, callback) {
            if (!origin) {
                return callback(null, true);
            }

            const allowed = [
                "https://cs2dep.online",
                "https://www.cs2dep.online",
                "https://api.cs2dep.online",
                "http://localhost:5173",
                "http://localhost:3000",
            ];

            if (
                origin.includes("framer.app") ||
                origin.includes("framercanvas.com") ||
                origin.includes("framer.work") ||
                origin.includes("framercanvas.net")
            ) {
                console.log("✅ CORS разрешён для Framer:", origin);
                return callback(null, true);
            }

            if (
                allowed.includes(origin) ||
                origin.includes("railway.app")
            ) {
                console.log("✅ CORS разрешён для:", origin);
                return callback(null, true);
            }

            console.log("❌ CORS заблокирован для:", origin);
            callback(new Error("Not allowed by CORS"));
        },

        credentials: true,

        methods: [
            "GET",
            "POST",
            "PUT",
            "DELETE",
            "OPTIONS",
        ],

        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "Accept",
        ],
    })
);

app.use(express.json());

// =======================================================
// POSTGRESQL
// =======================================================
const pool = new Pool({
    connectionString: DATABASE_URL,

    ssl: {
        rejectUnauthorized: false,
    },

    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// =======================================================
// SESSION STORE
// =======================================================
const pgSession = connectPgSimple(session);

let sessionStore = null;
let usingPostgresSessions = false;

// =======================================================
// FALLBACK MEMORY USERS
// Используется только если PostgreSQL недоступен
// =======================================================
const inMemoryUsers = new Map();

// =======================================================
// DATABASE INITIALIZATION
// =======================================================
async function initializeDatabase() {
    try {
        console.log("🔄 Проверяем PostgreSQL...");

        await pool.query("SELECT 1");

        console.log("✅ Подключение к PostgreSQL установлено!");

        // ---------------------------------------------------
        // USERS
        // ---------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                avatar VARCHAR(500),
                balance DECIMAL(10, 2) DEFAULT 0
            );
        `);

        console.log("✅ Таблица users готова");

        // ---------------------------------------------------
        // SESSION
        // ---------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "sid" varchar NOT NULL,
                "sess" json NOT NULL,
                "expire" timestamp(6) NOT NULL,
                CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS "IDX_session_expire"
            ON "session" ("expire");
        `);

        console.log("✅ Таблица session готова");

        // ---------------------------------------------------
        // CASES
        // ---------------------------------------------------
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

        console.log("✅ Таблица cases готова");

        // ---------------------------------------------------
        // CASE ITEMS
        // ---------------------------------------------------
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

        console.log("✅ Таблица case_items готова");

        // ---------------------------------------------------
        // INVENTORY
        // ---------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_inventory (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255)
                    REFERENCES users(id)
                    ON DELETE CASCADE,
                item_name VARCHAR(255) NOT NULL,
                item_image VARCHAR(500),
                rarity VARCHAR(50) NOT NULL,
                received_at TIMESTAMP DEFAULT NOW()
            );
        `);

        console.log("✅ Таблица user_inventory готова");

        // ---------------------------------------------------
        // CASE HISTORY
        // ---------------------------------------------------
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_cases_history (
                id SERIAL PRIMARY KEY,
                user_id VARCHAR(255)
                    REFERENCES users(id)
                    ON DELETE CASCADE,
                case_id INTEGER REFERENCES cases(id),
                item_id INTEGER REFERENCES case_items(id),
                opened_at TIMESTAMP DEFAULT NOW()
            );
        `);

        console.log("✅ Таблица user_cases_history готова");

        // ---------------------------------------------------
        // SESSION STORE
        // ---------------------------------------------------
        sessionStore = new pgSession({
            pool: pool,
            tableName: "session",
            createTableIfMissing: false,
        });

        usingPostgresSessions = true;

        console.log("✅ Session Store: PostgreSQL");
    } catch (error) {
        console.error(
            "❌ PostgreSQL недоступен:",
            error.message
        );

        console.log(
            "⚠️ Используем встроенный MemoryStore для сессий"
        );

        sessionStore = undefined;
        usingPostgresSessions = false;
    }
}

// =======================================================
// SESSION
// =======================================================
// ВАЖНО:
// НЕ УСТАНАВЛИВАЕМ connect.sid ВРУЧНУЮ
// express-session делает это самостоятельно.
// =======================================================
app.use(
    session({
        store: sessionStore,

        secret: SESSION_SECRET,

        resave: false,

        saveUninitialized: false,

        rolling: true,

        name: "cs2dep.sid",

        cookie: {
            httpOnly: true,

            secure: true,

            sameSite: "lax",

            path: "/",

            maxAge: 1000 * 60 * 60 * 24 * 7,
        },
    })
);

// =======================================================
// SESSION LOGGING
// =======================================================
app.use((req, res, next) => {
    const cookieHeader = req.headers.cookie || "";

    const cookieMatch = cookieHeader.match(
        /cs2dep\.sid=([^;]+)/
    );

    const rawCookie = cookieMatch
        ? cookieMatch[1]
        : null;

    let cookieSessionId = null;

    if (rawCookie) {
        try {
            // Express-session cookie имеет формат:
            // s:SESSION_ID.SIGNATURE
            const decoded = decodeURIComponent(rawCookie);

            if (decoded.startsWith("s:")) {
                cookieSessionId =
                    decoded
                        .substring(2)
                        .split(".")[0];
            }
        } catch (error) {
            cookieSessionId = null;
        }
    }

    console.log("\n🔍 СЕССИЯ:");
    console.log(
        "  Cookie:",
        rawCookie || "нет"
    );

    console.log(
        "  Cookie Session ID:",
        cookieSessionId || "не удалось определить"
    );

    console.log(
        "  Express Session ID:",
        req.session?.id || "нет"
    );

    console.log(
        "  IDs совпадают:",
        cookieSessionId &&
        req.session?.id &&
        cookieSessionId === req.session.id
            ? "✅ ДА"
            : "❌ НЕТ / НОВАЯ СЕССИЯ"
    );

    console.log(
        "  Store:",
        req.session?.store ? "✅ есть" : "❌ нет"
    );

    console.log(
        "  Passport:",
        JSON.stringify(
            req.session?.passport || "нет"
        )
    );

    console.log(
        "  PostgreSQL Sessions:",
        usingPostgresSessions ? "✅" : "❌ Memory"
    );

    next();
});

// =======================================================
// PASSPORT
// =======================================================
app.use(passport.initialize());
app.use(passport.session());

// =======================================================
// STEAM STRATEGY
// =======================================================
passport.use(
    new SteamStrategy(
        {
            returnURL:
                `${BASE_URL}/api/auth/steam/return`,

            realm: BASE_URL,

            apiKey: STEAM_API_KEY,
        },

        async function (
            identifier,
            profile,
            done
        ) {
            try {
                console.log("✅ Steam вернул профиль!");

                console.log(
                    "  ID:",
                    profile.id
                );

                console.log(
                    "  Name:",
                    profile.displayName
                );

                const user = {
                    id: profile.id,

                    name:
                        profile.displayName ||
                        "Steam User",

                    avatar:
                        profile.photos?.[0]?.value ||
                        "",

                    balance: 0,
                };

                // ------------------------------------------------
                // PostgreSQL
                // ------------------------------------------------
                if (usingPostgresSessions) {
                    await pool.query(
                        `
                        INSERT INTO users
                            (id, name, avatar, balance)
                        VALUES
                            ($1, $2, $3, $4)
                        ON CONFLICT (id)
                        DO UPDATE SET
                            name = EXCLUDED.name,
                            avatar = EXCLUDED.avatar
                        `,
                        [
                            user.id,
                            user.name,
                            user.avatar,
                            user.balance,
                        ]
                    );

                    console.log(
                        "✅ Пользователь сохранён в PostgreSQL"
                    );
                } else {
                    // ------------------------------------------------
                    // Memory fallback
                    // ------------------------------------------------
                    const existingUser =
                        inMemoryUsers.get(user.id);

                    if (existingUser) {
                        existingUser.name =
                            user.name;

                        existingUser.avatar =
                            user.avatar;

                        console.log(
                            "✅ Пользователь обновлён в памяти"
                        );
                    } else {
                        inMemoryUsers.set(
                            user.id,
                            user
                        );

                        console.log(
                            "✅ Пользователь сохранён в памяти"
                        );
                    }
                }

                return done(null, user);
            } catch (error) {
                console.error(
                    "❌ Ошибка Steam пользователя:",
                    error
                );

                return done(error);
            }
        }
    )
);

// =======================================================
// SERIALIZE USER
// =======================================================
passport.serializeUser(
    (user, done) => {
        console.log(
            "🔒 Сериализация:",
            user.id
        );

        done(null, user.id);
    }
);

// =======================================================
// DESERIALIZE USER
// =======================================================
passport.deserializeUser(
    async (id, done) => {
        try {
            console.log(
                "🔓 Десериализация:",
                id
            );

            // PostgreSQL
            if (usingPostgresSessions) {
                const result =
                    await pool.query(
                        "SELECT * FROM users WHERE id = $1",
                        [id]
                    );

                if (result.rows.length === 0) {
                    console.log(
                        "❌ Пользователь не найден"
                    );

                    return done(null, false);
                }

                console.log(
                    "✅ Пользователь найден:",
                    result.rows[0].name
                );

                return done(
                    null,
                    result.rows[0]
                );
            }

            // Memory
            const user =
                inMemoryUsers.get(id);

            if (!user) {
                console.log(
                    "❌ Пользователь не найден в памяти"
                );

                return done(null, false);
            }

            console.log(
                "✅ Пользователь найден в памяти:",
                user.name
            );

            return done(null, user);
        } catch (error) {
            console.error(
                "❌ Ошибка десериализации:",
                error
            );

            return done(error);
        }
    }
);

// =======================================================
// AUTH — STEAM
// =======================================================
app.get(
    "/api/auth/steam",
    (req, res, next) => {
        console.log(
            "\n🔄 Начало авторизации Steam"
        );

        console.log(
            "  Session ID:",
            req.session.id
        );

        next();
    },
    passport.authenticate("steam")
);

// =======================================================
// AUTH — STEAM RETURN
// =======================================================
app.get(
    "/api/auth/steam/return",

    (req, res, next) => {
        console.log(
            "\n🔄 Возврат от Steam"
        );

        console.log(
            "  Query:",
            req.query
        );

        console.log(
            "  Session ID до Passport:",
            req.session?.id
        );

        next();
    },

    passport.authenticate("steam", {
        failureRedirect:
            `${FRONTEND_URL}/?error=steam`,
        failureMessage: true,
    }),

    (req, res) => {
        console.log(
            "\n🎉 АУТЕНТИФИКАЦИЯ УСПЕШНА!"
        );

        console.log(
            "  User ID:",
            req.user?.id
        );

        console.log(
            "  User Name:",
            req.user?.name
        );

        console.log(
            "  Session ID:",
            req.session.id
        );

        console.log(
            "  Passport:",
            JSON.stringify(
                req.session.passport
            )
        );

        // ---------------------------------------------------
        // КРИТИЧЕСКИ ВАЖНО:
        // СОХРАНЯЕМ СЕССИЮ.
        // COOKIE ВРУЧНУЮ НЕ СОЗДАЁМ.
        // ---------------------------------------------------
        req.session.save((err) => {
            if (err) {
                console.error(
                    "❌ Ошибка сохранения сессии:",
                    err
                );

                return res.redirect(
                    `${FRONTEND_URL}/?error=session`
                );
            }

            console.log(
                "✅ Сессия сохранена"
            );

            console.log(
                "  Session ID:",
                req.session.id
            );

            console.log(
                "🍪 Cookie устанавливается express-session автоматически"
            );

            // ------------------------------------------------
            // Проверка сессии в PostgreSQL
            // ------------------------------------------------
            if (usingPostgresSessions) {
                pool.query(
                    'SELECT sid FROM "session" WHERE sid = $1',
                    [req.session.id]
                )
                    .then((result) => {
                        console.log(
                            "  Сессия в PostgreSQL:",
                            result.rows.length > 0
                                ? "✅ ЕСТЬ"
                                : "❌ НЕТ"
                        );
                    })
                    .catch((error) => {
                        console.error(
                            "  ❌ Ошибка проверки session:",
                            error.message
                        );
                    });
            }

            console.log(
                "🔗 Редирект:",
                FRONTEND_URL
            );

            res.redirect(FRONTEND_URL);
        });
    }
);

// =======================================================
// AUTH ME
// =======================================================
app.get(
    "/api/auth/me",
    (req, res) => {
        console.log(
            "\n🔍 /api/auth/me"
        );

        console.log(
            "  Session ID:",
            req.session?.id
        );

        console.log(
            "  Passport:",
            JSON.stringify(
                req.session?.passport ||
                "нет"
            )
        );

        console.log(
            "  isAuthenticated:",
            req.isAuthenticated?.()
        );

        console.log(
            "  req.user:",
            req.user?.id || "нет"
        );

        if (
            !req.isAuthenticated ||
            !req.isAuthenticated()
        ) {
            console.log(
                "❌ НЕ АВТОРИЗОВАН"
            );

            return res
                .status(401)
                .json({
                    error: "Unauthorized",
                });
        }

        console.log(
            "✅ АВТОРИЗОВАН:",
            req.user.name
        );

        res.json(req.user);
    }
);

// =======================================================
// CHECK SESSION
// =======================================================
app.get(
    "/api/auth/check-session",
    (req, res) => {
        res.json({
            sessionId:
                req.session?.id || null,

            isAuthenticated:
                req.isAuthenticated?.() ||
                false,

            user: req.user
                ? {
                    id: req.user.id,
                    name: req.user.name,
                }
                : null,

            passportUser:
                req.session?.passport?.user ||
                null,

            sessionStore:
                usingPostgresSessions
                    ? "postgres"
                    : "memory",

            cookie:
                req.headers.cookie || null,
        });
    }
);

// =======================================================
// LOGOUT
// =======================================================
app.post(
    "/api/auth/logout",
    (req, res) => {
        console.log(
            "\n🚪 Выход пользователя"
        );

        req.logout((logoutError) => {
            if (logoutError) {
                console.error(
                    "❌ Logout error:",
                    logoutError
                );

                return res
                    .status(500)
                    .json({
                        error:
                            logoutError.message,
                    });
            }

            req.session.destroy(
                (destroyError) => {
                    if (destroyError) {
                        console.error(
                            "❌ Session destroy error:",
                            destroyError
                        );

                        return res
                            .status(500)
                            .json({
                                error:
                                    destroyError.message,
                            });
                    }

                    res.clearCookie(
                        "cs2dep.sid",
                        {
                            httpOnly: true,
                            secure: true,
                            sameSite: "lax",
                            path: "/",
                        }
                    );

                    console.log(
                        "✅ Пользователь вышел"
                    );

                    res.json({
                        success: true,
                    });
                }
            );
        });
    }
);

// =======================================================
// CASES
// =======================================================
app.get(
    "/api/cases",
    async (req, res) => {
        try {
            const result =
                await pool.query(`
                    SELECT
                        id,
                        name,
                        price,
                        image,
                        is_active
                    FROM cases
                    WHERE is_active = true
                    ORDER BY id
                `);

            res.json(result.rows);
        } catch (error) {
            console.error(
                "❌ Ошибка получения кейсов:",
                error
            );

            res.status(500).json({
                error:
                    "Internal server error",
            });
        }
    }
);

// =======================================================
// CASE ITEMS
// =======================================================
app.get(
    "/api/cases/:id/items",
    async (req, res) => {
        try {
            const caseId =
                req.params.id;

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        image,
                        rarity,
                        chance
                    FROM case_items
                    WHERE case_id = $1
                    ORDER BY chance DESC
                    `,
                    [caseId]
                );

            res.json(result.rows);
        } catch (error) {
            console.error(
                "❌ Ошибка получения предметов:",
                error
            );

            res.status(500).json({
                error:
                    "Internal server error",
            });
        }
    }
);

// =======================================================
// OPEN CASE
// =======================================================
app.post(
    "/api/cases/:id/open",
    async (req, res) => {
        try {
            if (
                !req.isAuthenticated ||
                !req.isAuthenticated()
            ) {
                return res.status(401).json({
                    error:
                        "Unauthorized",
                });
            }

            const userId =
                req.user.id;

            const caseId =
                parseInt(req.params.id);

            const caseResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        price
                    FROM cases
                    WHERE id = $1
                    AND is_active = true
                    `,
                    [caseId]
                );

            if (
                caseResult.rows.length === 0
            ) {
                return res.status(404).json({
                    error:
                        "Case not found or inactive",
                });
            }

            const caseData =
                caseResult.rows[0];

            const price =
                parseFloat(caseData.price);

            const userResult =
                await pool.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE id = $1
                    `,
                    [userId]
                );

            if (
                userResult.rows.length === 0
            ) {
                return res.status(404).json({
                    error:
                        "User not found",
                });
            }

            const currentBalance =
                parseFloat(
                    userResult.rows[0]
                        .balance
                );

            if (
                currentBalance < price
            ) {
                return res.status(400).json({
                    error:
                        "Insufficient balance",
                    balance:
                        currentBalance,
                    required:
                        price,
                });
            }

            const itemsResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        image,
                        rarity,
                        chance
                    FROM case_items
                    WHERE case_id = $1
                    `,
                    [caseId]
                );

            if (
                itemsResult.rows.length === 0
            ) {
                return res.status(404).json({
                    error:
                        "No items in this case",
                });
            }

            const items =
                itemsResult.rows;

            const random =
                Math.random();

            let cumulative = 0;
            let selectedItem = null;

            for (const item of items) {
                cumulative +=
                    parseFloat(
                        item.chance
                    );

                if (
                    random <= cumulative
                ) {
                    selectedItem =
                        item;

                    break;
                }
            }

            if (!selectedItem) {
                selectedItem =
                    items[
                        items.length - 1
                    ];
            }

            const newBalance =
                currentBalance -
                price;

            await pool.query(
                `
                UPDATE users
                SET balance = $1
                WHERE id = $2
                `,
                [
                    newBalance,
                    userId,
                ]
            );

            await pool.query(
                `
                INSERT INTO user_inventory
                    (
                        user_id,
                        item_name,
                        item_image,
                        rarity
                    )
                VALUES
                    ($1, $2, $3, $4)
                `,
                [
                    userId,
                    selectedItem.name,
                    selectedItem.image,
                    selectedItem.rarity,
                ]
            );

            await pool.query(
                `
                INSERT INTO user_cases_history
                    (
                        user_id,
                        case_id,
                        item_id
                    )
                VALUES
                    ($1, $2, $3)
                `,
                [
                    userId,
                    caseId,
                    selectedItem.id,
                ]
            );

            res.json({
                success: true,

                case:
                    caseData.name,

                item: {
                    id:
                        selectedItem.id,

                    name:
                        selectedItem.name,

                    image:
                        selectedItem.image,

                    rarity:
                        selectedItem.rarity,
                },

                balance:
                    newBalance,

                price:
                    price,
            });
        } catch (error) {
            console.error(
                "❌ Ошибка открытия кейса:",
                error
            );

            res.status(500).json({
                error:
                    "Internal server error",
            });
        }
    }
);

// =======================================================
// INVENTORY
// =======================================================
app.get(
    "/api/user/inventory",
    async (req, res) => {
        try {
            if (
                !req.isAuthenticated ||
                !req.isAuthenticated()
            ) {
                return res.status(401).json({
                    error:
                        "Unauthorized",
                });
            }

            const userId =
                req.user.id;

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        item_name,
                        item_image,
                        rarity,
                        received_at
                    FROM user_inventory
                    WHERE user_id = $1
                    ORDER BY received_at DESC
                    `,
                    [userId]
                );

            res.json(result.rows);
        } catch (error) {
            console.error(
                "❌ Ошибка получения инвентаря:",
                error
            );

            res.status(500).json({
                error:
                    "Internal server error",
            });
        }
    }
);

// =======================================================
// BALANCE
// =======================================================
app.get(
    "/api/user/balance",
    async (req, res) => {
        try {
            if (
                !req.isAuthenticated ||
                !req.isAuthenticated()
            ) {
                return res.status(401).json({
                    error:
                        "Unauthorized",
                });
            }

            const userId =
                req.user.id;

            const result =
                await pool.query(
                    `
                    SELECT balance
                    FROM users
                    WHERE id = $1
                    `,
                    [userId]
                );

            if (
                result.rows.length === 0
            ) {
                return res.status(404).json({
                    error:
                        "User not found",
                });
            }

            res.json({
                balance:
                    parseFloat(
                        result.rows[0].balance
                    ),
            });
        } catch (error) {
            console.error(
                "❌ Ошибка получения баланса:",
                error
            );

            res.status(500).json({
                error:
                    "Internal server error",
            });
        }
    }
);

// =======================================================
// HEALTH
// =======================================================
app.get(
    "/api/health",
    (req, res) => {
        res.json({
            status: "ok",
            timestamp:
                new Date().toISOString(),
            sessionStore:
                usingPostgresSessions
                    ? "postgres"
                    : "memory",
        });
    }
);

// =======================================================
// 404
// =======================================================
app.use(
    (req, res) => {
        console.log(
            `❌ 404: ${req.method} ${req.path}`
        );

        res.status(404).json({
            error:
                "Not found",
        });
    }
);

// =======================================================
// ERROR HANDLER
// =======================================================
app.use(
    (err, req, res, next) => {
        console.error(
            "❌ Server error:",
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            error:
                err.message,
        });
    }
);

// =======================================================
// START SERVER
// =======================================================
async function startServer() {
    try {
        await initializeDatabase();

        app.listen(
            PORT,
            () => {
                console.log(
                    "\n========================================"
                );

                console.log(
                    "✅ SERVER ЗАПУЩЕН"
                );

                console.log(
                    "========================================"
                );

                console.log(
                    "PORT:",
                    PORT
                );

                console.log(
                    "BASE_URL:",
                    BASE_URL
                );

                console.log(
                    "FRONTEND_URL:",
                    FRONTEND_URL
                );

                console.log(
                    "SESSION STORE:",
                    usingPostgresSessions
                        ? "PostgreSQL"
                        : "MemoryStore"
                );

                console.log(
                    "Steam:",
                    `${BASE_URL}/api/auth/steam`
                );

                console.log(
                    "Me:",
                    `${BASE_URL}/api/auth/me`
                );

                console.log(
                    "Session Check:",
                    `${BASE_URL}/api/auth/check-session`
                );

                console.log(
                    "========================================\n"
                );
            }
        );
    } catch (error) {
        console.error(
            "❌ Критическая ошибка запуска:",
            error
        );

        process.exit(1);
    }
}

startServer();
```
