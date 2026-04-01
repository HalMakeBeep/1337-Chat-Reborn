const express = require("express");
const { UserModel } = require("../model/User.Model");
const { MessageModel } = require("../model/Message.Model");
const { BlacklistModel } = require("../model/Blacklist.Model");
const { authenticate } = require("../middleware/Authenticate");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const userRoutes = express.Router();

// Stricter rate limit for auth endpoints (login / signup)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,                  // 20 attempts per window
    message: { error: "Too many attempts. Please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Escape special regex characters to prevent ReDoS
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =====================================================
//  PUBLIC ROUTES (no auth required)
// =====================================================

userRoutes.post("/signup", authLimiter, async (req, res) => {
    const { name, email, password, picture } = req.body;

    // ---------- Input validation ----------
    if (!name || !email || !password) {
        return res
            .status(400)
            .json({ error: "Name, email, and password are required." });
    }

    const trimmedName = String(name).trim();
    if (trimmedName.length < 2 || trimmedName.length > 50) {
        return res
            .status(400)
            .json({ error: "Name must be between 2 and 50 characters." });
    }

    if (typeof password !== "string" || password.length < 6) {
        return res
            .status(400)
            .json({ error: "Password must be at least 6 characters." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res
            .status(400)
            .json({ error: "Please provide a valid email address." });
    }

    try {
        // Fixed: was using .size (undefined on arrays) — now uses findOne
        const userPresent = await UserModel.findOne({
            email: email.toLowerCase().trim(),
        });
        if (userPresent) {
            return res
                .status(400)
                .json({ error: "An account with this email already exists." });
        }

        // Fixed: salt rounds increased from 4 → 12
        const hashed_password = await bcrypt.hash(password, 12);

        const user = new UserModel({
            name: trimmedName,
            email: email.toLowerCase().trim(),
            password: hashed_password,
            picture: picture || undefined, // falls back to schema default
        });
        await user.save();

        res.status(201).json({ success: "User created successfully" });
    } catch (error) {
        console.error("Signup error:", error.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});

userRoutes.post("/login", authLimiter, async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res
            .status(400)
            .json({ error: "Email and password are required." });
    }

    try {
        const user = await UserModel.findOne({
            email: email.toLowerCase().trim(),
        });
        if (!user) {
            // Generic message — don't reveal if email exists
            return res
                .status(400)
                .json({ error: "Invalid email or password." });
        }

        const isPasswordMatch = await bcrypt.compare(password, user.password);
        if (!isPasswordMatch) {
            return res
                .status(400)
                .json({ error: "Invalid email or password." });
        }

        const token = jwt.sign(
            { userId: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "10h" }
        );
        const reftoken = jwt.sign(
            { userId: user._id },
            process.env.REF_SECRET,
            { expiresIn: "8h" }
        );

        return res.status(200).json({
            success: "User login successfully",
            token: token,
            reftoken: reftoken,
            userId: user._id,
        });
    } catch (error) {
        console.error("Login error:", error.message);
        res.status(500).json({ error: "Something went wrong. Please try again." });
    }
});

// =====================================================
//  PROTECTED ROUTES (require valid JWT)
// =====================================================

// --- Logout: blacklist the token ---
userRoutes.get("/logout", authenticate, async (req, res) => {
    const token = req.headers.authorization.split(" ")[1];
    try {
        const blacklist = new BlacklistModel({ token });
        await blacklist.save();
        return res
            .status(200)
            .json({ message: "User logged out successfully" });
    } catch (error) {
        // Token may already be blacklisted (duplicate key) — still fine
        return res
            .status(200)
            .json({ message: "User logged out successfully" });
    }
});

// --- Get all users except self (passwords excluded) ---
userRoutes.get("/allUser", authenticate, async (req, res) => {
    try {
        const users = await UserModel.find({
            _id: { $ne: req.userId },
        }).select("-password");

        res.json(users);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

// --- Get users you already have a conversation with ---
userRoutes.get("/alreadyConnectedUser", authenticate, async (req, res) => {
    try {
        const user = await UserModel.findById(req.userId).select("-password");
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Fixed: replaced N+1 loop queries with two efficient distinct() calls
        const sentTo = await MessageModel.distinct("receiverId", {
            senderId: req.userId,
        });
        const receivedFrom = await MessageModel.distinct("senderId", {
            receiverId: req.userId,
        });

        // Merge into a unique set of contact IDs
        const contactIdSet = new Set([
            ...sentTo.map((id) => id.toString()),
            ...receivedFrom.map((id) => id.toString()),
        ]);

        let contacts = [];
        if (contactIdSet.size > 0) {
            contacts = await UserModel.find({
                _id: { $in: [...contactIdSet] },
            }).select("-password");
        }

        res.json([contacts, user.name, user.picture, user.settings]);
    } catch (error) {
        console.error("Connected users error:", error.message);
        res.status(500).json({ error: "Failed to fetch connected users" });
    }
});

// --- Get chat summaries ordered by latest activity ---
userRoutes.get("/chatSummaries", authenticate, async (req, res) => {
    try {
        const messages = await MessageModel.find({
            $or: [
                { senderId: req.userId },
                { receiverId: req.userId },
            ],
        })
            .sort({ createdAt: -1 })
            .lean();

        const summariesMap = new Map();

        messages.forEach((msg) => {
            const senderId = msg.senderId.toString();
            const receiverId = msg.receiverId.toString();
            const otherUserId = senderId === req.userId.toString() ? receiverId : senderId;

            if (!summariesMap.has(otherUserId)) {
                summariesMap.set(otherUserId, {
                    lastMessage: msg.message,
                    lastMessageAt: msg.createdAt,
                    unreadCount: 0,
                });
            }

            if (receiverId === req.userId.toString() && msg.status !== "read") {
                summariesMap.get(otherUserId).unreadCount += 1;
            }
        });

        const contactIds = [...summariesMap.keys()];
        if (contactIds.length === 0) {
            return res.json([]);
        }

        const contacts = await UserModel.find({
            _id: { $in: contactIds },
        })
            .select("name picture")
            .lean();

        const contactsById = new Map(
            contacts.map((contact) => [contact._id.toString(), contact])
        );

        const summaries = contactIds
            .map((contactId) => {
                const contact = contactsById.get(contactId);
                if (!contact) return null;

                const summary = summariesMap.get(contactId);
                return {
                    _id: contactId,
                    contact: {
                        _id: contactId,
                        name: contact.name,
                        picture: contact.picture,
                    },
                    lastMessage: summary.lastMessage,
                    lastMessageAt: summary.lastMessageAt,
                    unreadCount: summary.unreadCount,
                };
            })
            .filter(Boolean)
            .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

        res.json(summaries);
    } catch (error) {
        console.error("Chat summaries error:", error.message);
        res.status(500).json({ error: "Failed to fetch chat summaries" });
    }
});

// --- Search users by name (regex injection fixed) ---
userRoutes.get("/searchUser", authenticate, async (req, res) => {
    const { search } = req.query;
    try {
        const escapedSearch = escapeRegex(search || "");
        const users = await UserModel.find({
            _id: { $ne: req.userId },
            name: { $regex: escapedSearch, $options: "i" },
        }).select("-password");

        res.json(users);
    } catch (error) {
        res.status(500).json({ error: "Search failed" });
    }
});

// --- Refresh access token using refresh token ---
userRoutes.get("/apiRefresh", async (req, res) => {
    if (
        !req.headers.authorization ||
        !req.headers.authorization.startsWith("Bearer ")
    ) {
        return res
            .status(401)
            .json({ message: "No refresh token provided" });
    }

    const reftoken = req.headers.authorization.split(" ")[1];
    try {
        const decoded = jwt.verify(reftoken, process.env.REF_SECRET);
        const { userId } = decoded;

        const user = await UserModel.findById(userId);
        if (!user) {
            return res.status(403).json({ message: "Unauthorized" });
        }

        const token = jwt.sign(
            { userId: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "10h" }
        );

        res.json({ token });
    } catch (error) {
        return res.status(403).json({ message: "Login First" });
    }
});

// --- Get all messages between authenticated user and another user ---
userRoutes.get("/getAllMessages", authenticate, async (req, res) => {
    const { user2 } = req.query;
    const user1 = req.userId;

    if (!user2) {
        return res
            .status(400)
            .json({ error: "user2 parameter is required" });
    }

    try {
        // Query the Message collection (no more embedded arrays)
        const messages = await MessageModel.find({
            $or: [
                { senderId: user1, receiverId: user2 },
                { senderId: user2, receiverId: user1 },
            ],
        }).sort({ createdAt: 1 });

        const allData = messages.map((msg) => ({
            data: {
                _id: msg._id.toString(),
                message: msg.message,
                senderId: msg.senderId.toString(),
                receiverId: msg.receiverId.toString(),
                timestamp: msg.createdAt,
                status: msg.status || "sent",
            },
            type:
                msg.senderId.toString() === user1.toString()
                    ? "send"
                    : "receive",
        }));

        res.json(allData);
    } catch (error) {
        console.error("Get messages error:", error.message);
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});

// --- Delete chat between authenticated user and another user ---
// Fixed: original $or query was broken (checked both fields against receiver)
userRoutes.put("/deleteChatMessages", authenticate, async (req, res) => {
    const { receiver } = req.body;
    const sender = req.userId;

    if (!receiver) {
        return res
            .status(400)
            .json({ error: "Receiver ID is required" });
    }

    try {
        const result = await MessageModel.deleteMany({
            $or: [
                { senderId: sender, receiverId: receiver },
                { senderId: receiver, receiverId: sender },
            ],
        });

        res.json({
            message: "Chat deleted successfully",
            deletedCount: result.deletedCount,
        });

        const emitToUser = req.app.get("emitToUser");
        if (emitToUser) {
            emitToUser(sender.toString(), "chatsUpdated");
            emitToUser(receiver.toString(), "chatsUpdated");
        }
    } catch (error) {
        console.error("Delete messages error:", error.message);
        res.status(500).json({ error: "Failed to delete messages" });
    }
});

// --- Get user settings ---
userRoutes.get("/settings", authenticate, async (req, res) => {
    try {
        const user = await UserModel.findById(req.userId).select("settings name picture");
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch settings" });
    }
});

// --- Update user settings / profile ---
userRoutes.put("/settings", authenticate, async (req, res) => {
    const { name, picture, settings } = req.body;
    try {
        const update = {};
        if (name && typeof name === "string" && name.trim().length >= 2 && name.trim().length <= 50) {
            update.name = name.trim();
        }
        if (picture && typeof picture === "string") {
            update.picture = picture;
        }
        if (settings && typeof settings === "object") {
            const validThemes = ["purple", "blue", "green", "red"];
            const validFontSizes = ["small", "medium", "large"];
            if (settings.theme && validThemes.includes(settings.theme)) update["settings.theme"] = settings.theme;
            if (settings.fontSize && validFontSizes.includes(settings.fontSize)) update["settings.fontSize"] = settings.fontSize;
            if (typeof settings.notifications === "boolean") update["settings.notifications"] = settings.notifications;
            if (typeof settings.readReceipts === "boolean") update["settings.readReceipts"] = settings.readReceipts;
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ error: "No valid fields to update" });
        }

        await UserModel.updateOne({ _id: req.userId }, { $set: update });
        const updated = await UserModel.findById(req.userId).select("settings name picture");
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: "Failed to update settings" });
    }
});

module.exports = {
    userRoutes,
};
