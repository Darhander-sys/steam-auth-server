```javascript
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
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);

console.log("========================================");
console.log("🚀 ЗАПУСК СЕРВЕРА");
console.log("========================================");
console.log("BASE_URL:", BASE_URL);
console.log("FRONTEND_URL:", FRONTEND_URL);
console.log("PORT:", PORT);

// =======================================================
// ENV VALIDATION
// =======================================================

if (!STEAM_API_KEY) {
    console.error("❌ STEAM_API_KEY отсутствует");
    process.exit(1);
}

if (!SESSION_SECRET) {
    console.error("❌ SESSION_SECRET отсутствует");
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL отсутствует");
    process.exit(1);
}

// =======================================================
// EXPRESS
// =======================================================

const app = express();

// Railway работает через reverse proxy.
// Это обязательно для secure cookies.
app.set("trust proxy", 1);

// =======================================================
// CORS
// =======================================================

const allowedOrigins = [
    "https://cs2dep.online",
    "https://www.cs2dep.online",
    "https://api.cs2dep.online",
    "http://localhost:3000",
    "http://localhost:5173",
];

app.use(
    cors({
        origin: function (origin, callback) {
            // Запросы без Origin
            if (!origin) {
                return callback(null, true);
            }

            // Основные домены
            if (allowedOrigins.includes(origin)) {
                console.log("✅ CORS:", origin);
                return callback(null, true);
            }

            // Framer preview
            if (
                origin.includes("framer.app") ||
                origin.includes("framer.website") ||
                origin.includes("framer.com") ||
                origin.includes("framercanvas.com") ||
                origin.includes("framer.work") ||
                origin.includes("framercanvas.net")
            ) {
                console.log("✅ Framer CORS:", origin);
                return callback(null, true);
            }

            console.log("❌ CORS BLOCKED:", origin);

            return callback(
                new Error("Not allowed by CORS")
            );
        },

        credentials: true,

        methods: [
            "GET",
            "POST",
            "PUT",
            "PATCH",
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
// SESSION CONFIG
// =======================================================

const pgSession = connectPgSimple(session);

let sessionStore = null;

// =======================================================
// DATABASE INITIALIZATION
// =======================================================

async function initializeDatabase() {
    console.log("🔄 Проверяем PostgreSQL...");

    await pool.query("SELECT 1");

    console.log("✅ PostgreSQL подключён");

    // ===================================================
    // USERS
    // ===================================================

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(255) PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            avatar VARCHAR(500),
            balance DECIMAL(10, 2) DEFAULT 0
        );
    `);

    console.log("✅ Таблица users готова");

    // ===================================================
    // SESSION
    // ===================================================

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

    // ===================================================
    // CASES
    // ===================================================

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

    // ===================================================
    // CASE ITEMS
    // ===================================================

    await pool.query(`
        CREATE TABLE IF NOT EXISTS case_items (
            id SERIAL PRIMARY KEY,
            case_id INTEGER
                REFERENCES cases(id)
                ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            image VARCHAR(500),
            rarity VARCHAR(50) NOT NULL,
            chance DECIMAL(5, 4) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    console.log("✅ Таблица case_items готова");

    // ===================================================
    // INVENTORY
    // ===================================================

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

    console.log(
        "✅ Таблица user_inventory готова"
    );

    // ===================================================
    // HISTORY
    // ===================================================

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_cases_history (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(255)
                REFERENCES users(id)
                ON DELETE CASCADE,
            case_id INTEGER
                REFERENCES cases(id),
            item_id INTEGER
                REFERENCES case_items(id),
            opened_at TIMESTAMP DEFAULT NOW()
        );
    `);

    console.log(
        "✅ Таблица user_cases_history готова"
    );

    // ===================================================
    // SESSION STORE
    // ===================================================

    sessionStore = new pgSession({
        pool: pool,
        tableName: "session",
        createTableIfMissing: false,
    });

    console.log(
        "✅ Session Store подключён: PostgreSQL"
    );
}

// =======================================================
// SESSION
// =======================================================
//
// ВАЖНО:
//
// express-session сам создаёт cookie.
//
// НЕ нужно делать:
// res.cookie("connect.sid", ...)
//
// Это было одной из причин проблемы.
// =======================================================

async function setupSession() {
    await initializeDatabase();

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

                maxAge:
                    1000 *
                    60 *
                    60 *
                    24 *
                    7,
            },
        })
    );

    console.log(
        "✅ Express Session подключён"
    );

    // ===================================================
    // SESSION DEBUG
    // ===================================================

    app.use((req, res, next) => {
        console.log("\n------------------------------");
        console.log(
            `📥 ${req.method} ${req.originalUrl}`
        );

        console.log(
            "Cookie:",
            req.headers.cookie || "нет"
        );

        console.log(
            "Session ID:",
            req.session?.id || "нет"
        );

        console.log(
            "Passport:",
            JSON.stringify(
                req.session?.passport || null
            )
        );

        console.log(
            "Authenticated:",
            req.isAuthenticated?.() || false
        );

        console.log("------------------------------");

        next();
    });

    // ===================================================
    // PASSPORT
    // ===================================================

    app.use(passport.initialize());
    app.use(passport.session());

    console.log("✅ Passport подключён");
}

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

        async (
            identifier,
            profile,
            done
        ) => {
            try {
                console.log(
                    "\n✅ STEAM PROFILE"
                );

                console.log(
                    "Steam ID:",
                    profile.id
                );

                console.log(
                    "Name:",
                    profile.displayName
                );

                const user = {
                    id: String(profile.id),

                    name:
                        profile.displayName ||
                        "Steam User",

                    avatar:
                        profile.photos?.[0]?.value ||
                        "",

                    balance: 0,
                };

                // ==========================================
                // SAVE USER
                // ==========================================

                await pool.query(
                    `
                    INSERT INTO users (
                        id,
                        name,
                        avatar,
                        balance
                    )
                    VALUES ($1, $2, $3, $4)

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

                return done(null, user);
            } catch (error) {
                console.error(
                    "❌ Ошибка Steam:",
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
            "🔒 serializeUser:",
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
                "🔓 deserializeUser:",
                id
            );

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        name,
                        avatar,
                        balance
                    FROM users
                    WHERE id = $1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {
                console.log(
                    "❌ Пользователь не найден"
                );

                return done(null, false);
            }

            const user =
                result.rows[0];

            console.log(
                "✅ Пользователь найден:",
                user.name
            );

            done(null, user);
        } catch (error) {
            console.error(
                "❌ Ошибка deserializeUser:",
                error
            );

            done(error);
        }
    }
);

// =======================================================
// AUTH — START STEAM LOGIN
// =======================================================

app.get(
    "/api/auth/steam",

    (req, res, next) => {
        console.log(
            "\n🔄 НАЧАЛО STEAM АВТОРИЗАЦИИ"
        );

        console.log(
            "Session ID:",
            req.session.id
        );

        next();
    },

    passport.authenticate("steam")
);

// =======================================================
// AUTH — STEAM CALLBACK
// =======================================================

app.get(
    "/api/auth/steam/return",

    (req, res, next) => {
        console.log(
            "\n🔄 STEAM CALLBACK"
        );

        console.log(
            "Session BEFORE passport:",
            req.session.id
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
            "\n🎉 STEAM АВТОРИЗАЦИЯ УСПЕШНА"
        );

        console.log(
            "User:",
            req.user
        );

        console.log(
            "Session ID:",
            req.session.id
        );

        console.log(
            "Passport session:",
            JSON.stringify(
                req.session.passport
            )
        );

        // =================================================
        // SAVE SESSION
        // =================================================

        req.session.save(
            async (error) => {
                if (error) {
                    console.error(
                        "❌ Ошибка сохранения session:",
                        error
                    );

                    return res.redirect(
                        `${FRONTEND_URL}/?error=session`
                    );
                }

                console.log(
                    "✅ SESSION СОХРАНЕНА"
                );

                console.log(
                    "Session ID:",
                    req.session.id
                );

                // =========================================
                // VERIFY SESSION IN POSTGRES
                // =========================================

                try {
                    const result =
                        await pool.query(
                            `
                            SELECT
                                sid,
                                sess,
                                expire
                            FROM "session"
                            WHERE sid = $1
                            `,
                            [req.session.id]
                        );

                    if (
                        result.rows.length > 0
                    ) {
                        console.log(
                            "✅ SESSION НАЙДЕНА В POSTGRESQL"
                        );

                        console.log(
                            "Session DB ID:",
                            result.rows[0].sid
                        );
                    } else {
                        console.error(
                            "❌ SESSION НЕ НАЙДЕНА В POSTGRESQL"
                        );
                    }
                } catch (dbError) {
                    console.error(
                        "❌ Ошибка проверки session:",
                        dbError
                    );
                }

                // =========================================
                // НЕ СОЗДАЁМ COOKIE ВРУЧНУЮ
                // =========================================

                console.log(
                    "🍪 Cookie установит express-session"
                );

                console.log(
                    "🔗 Redirect:",
                    FRONTEND_URL
                );

                return res.redirect(
                    FRONTEND_URL
                );
            }
        );
    }
);

// =======================================================
// CURRENT USER
// =======================================================

app.get(
    "/api/auth/me",
    (req, res) => {
        console.log(
            "\n🔍 /api/auth/me"
        );

        console.log(
            "Session ID:",
            req.session?.id
        );

        console.log(
            "Passport:",
            JSON.stringify(
                req.session?.passport || null
            )
        );

        console.log(
            "Authenticated:",
            req.isAuthenticated?.()
        );

        console.log(
            "User:",
            req.user?.id || "нет"
        );

        if (
            !req.isAuthenticated ||
            !req.isAuthenticated()
        ) {
            console.log(
                "❌ НЕ АВТОРИЗОВАН"
            );

            return res.status(401).json({
                error: "Unauthorized",
            });
        }

        console.log(
            "✅ АВТОРИЗОВАН:",
            req.user.name
        );

        res.json({
            id: req.user.id,

            name: req.user.name,

            avatar: req.user.avatar,

            balance: req.user.balance,
        });
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
                      avatar: req.user.avatar,
                  }
                : null,

            passportUser:
                req.session?.passport?.user ||
                null,

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
            "\n🚪 LOGOUT"
        );

        req.logout((logoutError) => {
            if (logoutError) {
                console.error(
                    "❌ logout:",
                    logoutError
                );

                return res.status(500).json({
                    error:
                        logoutError.message,
                });
            }

            req.session.destroy(
                (sessionError) => {
                    if (sessionError) {
                        console.error(
                            "❌ destroy session:",
                            sessionError
                        );

                        return res
                            .status(500)
                            .json({
                                error:
                                    sessionError.message,
                            });
                    }

                    // ВАЖНО:
                    // используется новое имя cookie
                    res.clearCookie(
                        "cs2dep.sid",
                        {
                            httpOnly:
                                true,
                            secure:
                                true,
                            sameSite:
                                "lax",
                            path: "/",
                        }
                    );

                    console.log(
                        "✅ LOGOUT УСПЕШЕН"
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
                "❌ Ошибка cases:",
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
                "❌ Ошибка case items:",
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
            // ----------------------------------------------
            // AUTH
            // ----------------------------------------------

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
                Number(req.params.id);

            if (
                !Number.isInteger(caseId)
            ) {
                return res.status(400).json({
                    error:
                        "Invalid case ID",
                });
            }

            // ----------------------------------------------
            // CASE
            // ----------------------------------------------

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
                Number(caseData.price);

            // ----------------------------------------------
            // USER BALANCE
            // ----------------------------------------------

            const userResult =
                await pool.query(
                    `
                    SELECT
                        balance
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
                Number(
                    userResult
                        .rows[0]
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

            // ----------------------------------------------
            // ITEMS
            // ----------------------------------------------

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

            // ----------------------------------------------
            // RANDOM ITEM
            // ----------------------------------------------

            const random =
                Math.random();

            let cumulative = 0;

            let selectedItem = null;

            for (
                const item of items
            ) {
                cumulative += Number(
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

            // ----------------------------------------------
            // NEW BALANCE
            // ----------------------------------------------

            const newBalance =
                currentBalance -
                price;

            // ----------------------------------------------
            // UPDATE BALANCE
            // ----------------------------------------------

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

            // ----------------------------------------------
            // INVENTORY
            // ----------------------------------------------

            await pool.query(
                `
                INSERT INTO user_inventory (
                    user_id,
                    item_name,
                    item_image,
                    rarity
                )
                VALUES ($1, $2, $3, $4)
                `,
                [
                    userId,

                    selectedItem.name,

                    selectedItem.image,

                    selectedItem.rarity,
                ]
            );

            // ----------------------------------------------
            // HISTORY
            // ----------------------------------------------

            await pool.query(
                `
                INSERT INTO user_cases_history (
                    user_id,
                    case_id,
                    item_id
                )
                VALUES ($1, $2, $3)
                `,
                [
                    userId,

                    caseId,

                    selectedItem.id,
                ]
            );

            // ----------------------------------------------
            // RESPONSE
            // ----------------------------------------------

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
                "❌ Ошибка inventory:",
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
                    SELECT
                        balance
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
                    Number(
                        result
                            .rows[0]
                            .balance
                    ),
            });
        } catch (error) {
            console.error(
                "❌ Ошибка balance:",
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
// HEALTH CHECK
// =======================================================

app.get(
    "/api/health",
    async (req, res) => {
        try {
            await pool.query("SELECT 1");

            res.json({
                status: "ok",

                database: "connected",

                timestamp:
                    new Date().toISOString(),
            });
        } catch (error) {
            res.status(500).json({
                status: "error",

                database:
                    "disconnected",
            });
        }
    }
);

// =======================================================
// 404
// =======================================================

app.use(
    (req, res) => {
        console.log(
            `❌ 404: ${req.method} ${req.originalUrl}`
        );

        res.status(404).json({
            error: "Not found",
        });
    }
);

// =======================================================
// ERROR HANDLER
// =======================================================

app.use(
    (
        err,
        req,
        res,
        next
    ) => {
        console.error(
            "❌ SERVER ERROR:",
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            error:
                err.message ||
                "Internal server error",
        });
    }
);

// =======================================================
// START
// =======================================================

async function startServer() {
    try {
        await setupSession();

        app.listen(
            PORT,
            () => {
                console.log(
                    "\n========================================"
                );

                console.log(
                    "✅ SERVER УСПЕШНО ЗАПУЩЕН"
                );

                console.log(
                    "========================================"
                );

                console.log(
                    "API:",
                    BASE_URL
                );

                console.log(
                    "Frontend:",
                    FRONTEND_URL
                );

                console.log(
                    "Steam Login:",
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
                    "Health:",
                    `${BASE_URL}/api/health`
                );

                console.log(
                    "Session Store: PostgreSQL"
                );

                console.log(
                    "========================================\n"
                );
            }
        );
    } catch (error) {
        console.error(
            "\n❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА"
        );

        console.error(error);

        console.error(
            "\nСервер остановлен."
        );

        process.exit(1);
    }
}

startServer();
```
