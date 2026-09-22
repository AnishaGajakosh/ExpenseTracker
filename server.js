const express = require("express");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");

const app = express();
const client = new MongoClient("mongodb://127.0.0.1:27017");
const dbName = "expenseTrackerDB";
const SESSION_DAYS = 7;
const GMAIL_REGEX = /^[^\s@]+@gmail\.com$/i;

let db, usersCollection, expensesCollection, sessionsCollection;

app.use(express.json());
app.use(express.static(__dirname));

function validGmail(email) {
    return typeof email === "string" && GMAIL_REGEX.test(email.trim());
}
function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, derived) => {
            if (err) reject(err);
            else resolve(`${salt}:${derived.toString("hex")}`);
        });
    });
}
function verifyPassword(password, stored) {
    return new Promise((resolve, reject) => {
        const [salt, key] = String(stored || "").split(":");
        if (!salt || !key) return resolve(false);
        crypto.scrypt(password, salt, 64, (err, derived) => {
            if (err) return reject(err);
            const saved = Buffer.from(key, "hex");
            resolve(saved.length === derived.length && crypto.timingSafeEqual(saved, derived));
        });
    });
}

function verifyLegacyPassword(password, passwordHash, passwordSalt) {
    return new Promise((resolve, reject) => {
        if (!passwordHash || !passwordSalt) return resolve(false);
        crypto.scrypt(password, passwordSalt, 64, (err, derived) => {
            if (err) return reject(err);
            const saved = Buffer.from(String(passwordHash), "hex");
            resolve(saved.length === derived.length && crypto.timingSafeEqual(saved, derived));
        });
    });
}
async function auth(req, res, next) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!token) return res.status(401).json({ message: "Please sign in" });

        const session = await sessionsCollection.findOne({
            tokenHash: hashToken(token),
            expiresAt: { $gt: new Date() }
        });
        if (!session) return res.status(401).json({ message: "Session expired. Please sign in again." });

        req.userId = session.userId;
        next();
    } catch (error) {
        console.error(error);
        res.status(401).json({ message: "Authentication failed" });
    }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/api/auth/signup", async (req, res) => {
    try {
        const name = String(req.body.name || "").trim();
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (!name || name.length < 2) return res.status(400).json({ message: "Please enter your name." });
        if (!validGmail(email)) return res.status(400).json({ message: "Invalid email address." });
        if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });

        const existing = await usersCollection.findOne({ email });
        if (existing) return res.status(409).json({ message: "An account with this email already exists." });

        const passwordHash = await hashPassword(password);
        await usersCollection.insertOne({
            name, email, passwordHash, createdAt: new Date()
        });

        res.status(201).json({ message: "Account created. Please sign in." });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error creating account." });
    }
});

app.post("/api/auth/signin", async (req, res) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");

        if (!validGmail(email)) return res.status(400).json({ message: "Invalid email address." });
        if (!password) return res.status(400).json({ message: "Please enter your password." });

        const user = await usersCollection.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: "Incorrect email or password." });
        }

        let passwordValid = false;

        if (user.passwordHash && String(user.passwordHash).includes(":")) {
            passwordValid = await verifyPassword(password, user.passwordHash);
        } else {
            passwordValid = await verifyLegacyPassword(password, user.passwordHash, user.passwordSalt);

            if (passwordValid) {
                const upgradedHash = await hashPassword(password);
                await usersCollection.updateOne(
                    { _id: user._id },
                    { $set: { passwordHash: upgradedHash }, $unset: { passwordSalt: "" } }
                );
            }
        }

        if (!passwordValid) {
            return res.status(401).json({ message: "Incorrect email or password." });
        }

        const token = crypto.randomBytes(32).toString("hex");
        await sessionsCollection.insertOne({
            tokenHash: hashToken(token),
            userId: user._id,
            expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000),
            createdAt: new Date()
        });

        res.json({ token, user: { name: user.name, email: user.email } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error signing in." });
    }
});

app.get("/api/auth/me", auth, async (req, res) => {
    const user = await usersCollection.findOne({ _id: req.userId }, { projection: { passwordHash: 0 } });
    if (!user) return res.status(401).json({ message: "User not found." });
    res.json({ user: { name: user.name, email: user.email } });
});

app.post("/api/auth/logout", auth, async (req, res) => {
    const header = req.headers.authorization || "";
    const token = header.slice(7);
    await sessionsCollection.deleteOne({ tokenHash: hashToken(token) });
    res.json({ message: "Logged out." });
});

app.post("/api/expenses", auth, async (req, res) => {
    try {
        const expense = {
            userId: req.userId,
            amount: Number(req.body.amount),
            category: String(req.body.category || "").trim(),
            description: String(req.body.description || "").trim(),
            date: String(req.body.date || "")
        };
        if (!Number.isFinite(expense.amount) || expense.amount <= 0 || !expense.category || !expense.description || !expense.date) {
            return res.status(400).json({ message: "Please enter valid expense details." });
        }
        const result = await expensesCollection.insertOne(expense);
        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error adding expense" });
    }
});

app.get("/api/expenses", auth, async (req, res) => {
    try {
        const { search, category, sort } = req.query;
        const query = { userId: req.userId };
        if (search) query.$or = [
            { description: { $regex: search, $options: "i" } },
            { category: { $regex: search, $options: "i" } }
        ];
        if (category) query.category = category;

        let sortOption = { date: -1 };
        if (sort === "date-asc") sortOption = { date: 1 };
        if (sort === "amount-desc") sortOption = { amount: -1 };
        if (sort === "amount-asc") sortOption = { amount: 1 };

        res.json(await expensesCollection.find(query).sort(sortOption).toArray());
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error loading expenses" });
    }
});

app.put("/api/expenses/:id", auth, async (req, res) => {
    try {
        const id = new ObjectId(req.params.id);
        const updatedExpense = {
            amount: Number(req.body.amount),
            category: String(req.body.category || "").trim(),
            description: String(req.body.description || "").trim(),
            date: String(req.body.date || "")
        };
        const result = await expensesCollection.updateOne(
            { _id: id, userId: req.userId },
            { $set: updatedExpense }
        );
        if (!result.matchedCount) return res.status(404).json({ message: "Expense not found." });
        res.json({ message: "Expense updated" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error updating expense" });
    }
});

app.delete("/api/expenses/:id", auth, async (req, res) => {
    try {
        const result = await expensesCollection.deleteOne({
            _id: new ObjectId(req.params.id),
            userId: req.userId
        });
        if (!result.deletedCount) return res.status(404).json({ message: "Expense not found." });
        res.json({ message: "Expense deleted" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error deleting expense" });
    }
});

app.get("/api/dashboard", auth, async (req, res) => {
    try {
        const summary = await expensesCollection.aggregate([
            { $match: { userId: req.userId } },
            { $group: {
                _id: null,
                totalExpenses: { $sum: "$amount" },
                expenseCount: { $sum: 1 },
                highestExpense: { $max: "$amount" }
            }}
        ]).toArray();

        const recentExpenses = await expensesCollection.find({ userId: req.userId })
            .sort({ date: -1 }).limit(5).toArray();

        const result = summary[0] || { totalExpenses: 0, expenseCount: 0, highestExpense: 0 };
        res.json({ ...result, recentExpenses });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error loading dashboard" });
    }
});

app.get("/api/analytics", auth, async (req, res) => {
    try {
        const match = { $match: { userId: req.userId } };
        const overall = await expensesCollection.aggregate([
            match,
            { $group: {
                _id: null,
                totalExpense: { $sum: "$amount" },
                averageExpense: { $avg: "$amount" },
                highestExpense: { $max: "$amount" }
            }}
        ]).toArray();

        const categorySummary = await expensesCollection.aggregate([
            match,
            { $group: {
                _id: "$category",
                totalAmount: { $sum: "$amount" },
                count: { $sum: 1 }
            }},
            { $sort: { totalAmount: -1 } }
        ]).toArray();

        const result = overall[0] || { totalExpense: 0, averageExpense: 0, highestExpense: 0 };
        res.json({
            totalExpense: result.totalExpense,
            averageExpense: Number((result.averageExpense || 0).toFixed(2)),
            highestExpense: result.highestExpense || 0,
            categorySummary
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Error loading analytics" });
    }
});

async function startServer() {
    try {
        await client.connect();
        db = client.db(dbName);
        usersCollection = db.collection("users");
        expensesCollection = db.collection("expenses");
        sessionsCollection = db.collection("sessions");

        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await expensesCollection.createIndex({ userId: 1, date: -1 });
        await sessionsCollection.createIndex({ tokenHash: 1 }, { unique: true });
        await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

        app.listen(3000, () => console.log("Server running on http://localhost:3000"));
    } catch (error) {
        console.error("Failed to start server:", error);
    }
}
startServer();
