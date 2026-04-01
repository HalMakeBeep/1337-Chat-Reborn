const express = require("express");
const { connection } = require("./config/db");
const { userRoutes } = require("./routes/User.Routes");
const { groupRoutes } = require("./routes/Group.Routes");
const { friendRoutes } = require("./routes/Friend.Routes");
const { MessageModel } = require("./model/Message.Model");
const { BlacklistModel } = require("./model/Blacklist.Model");
const { GroupModel } = require("./model/Group.Model");
const { GroupMessageModel } = require("./model/GroupMessage.Model");
const { GroupReadStateModel } = require("./model/GroupReadState.Model");
const { UserModel } = require("./model/User.Model");
const { createServer } = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const httpServer = createServer(app);

app.use(helmet());

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: "Too many requests. Please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalLimiter);

app.use(
    cors({
        origin: process.env.CORS_ORIGIN || "*",
        credentials: true,
    })
);

app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
    res.send("1337 Chat Server Online.");
});

app.use("/user", userRoutes);
app.use("/group", groupRoutes);
app.use("/friend", friendRoutes);

const io = new Server(httpServer, {
    cors: {
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
    },
});

io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication required"));
    try {
        const isBlocked = await BlacklistModel.findOne({ token });
        if (isBlocked) return next(new Error("Token has been revoked"));
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.userId;
        next();
    } catch (err) {
        next(new Error("Invalid or expired token"));
    }
});

const onlineUsers = new Map();

function addUserSocket(userId, socketId) {
    if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
    }
    onlineUsers.get(userId).add(socketId);
}

function removeUserSocket(userId, socketId) {
    const sockets = onlineUsers.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) {
        onlineUsers.delete(userId);
    }
}

function isUserOnline(userId) {
    return onlineUsers.has(userId) && onlineUsers.get(userId).size > 0;
}

function emitToUser(userId, eventName, ...args) {
    const sockets = onlineUsers.get(userId);
    if (!sockets) return;
    sockets.forEach((socketId) => io.to(socketId).emit(eventName, ...args));
}

app.set("emitToUser", emitToUser);

io.on("connection", async (socket) => {
    const authenticatedUserId = socket.userId;
    addUserSocket(authenticatedUserId, socket.id);
    socket.activeDmUserId = null;
    socket.canMarkRead = false;
    socket.activeGroupId = null;
    socket.canMarkGroupRead = false;
    console.log(`User connected: ${authenticatedUserId}`);

    // Auto-join group rooms
    try {
        const groups = await GroupModel.find({
            $or: [{ admin: authenticatedUserId }, { members: authenticatedUserId }],
        });
        groups.forEach((g) => socket.join("group:" + g._id.toString()));
    } catch (e) {
        console.error("Failed to join group rooms:", e.message);
    }

    // Deliver any undelivered messages that were sent while user was offline
    try {
        const undelivered = await MessageModel.find({ receiverId: authenticatedUserId, status: "sent" });
        if (undelivered.length > 0) {
            await MessageModel.updateMany(
                { receiverId: authenticatedUserId, status: "sent" },
                { $set: { status: "delivered" } }
            );
            const senderIds = [...new Set(undelivered.map((m) => m.senderId.toString()))];
            senderIds.forEach((sid) => {
                const msgIds = undelivered
                    .filter((m) => m.senderId.toString() === sid)
                    .map((m) => m._id.toString());
                emitToUser(sid, "msgDelivered", msgIds);
            });
        }
    } catch (e) {
        console.error("Failed to deliver pending messages:", e.message);
    }

    // --------------- DM Chat ---------------
    socket.on("chatMsg", async (msg, receiverId) => {
        const senderId = authenticatedUserId;
        if (!msg || typeof msg !== "string" || msg.trim().length === 0) return;
        if (!receiverId || typeof receiverId !== "string") return;

        const sanitizedMsg = msg.trim().substring(0, 5000);
        const isReceiverOnline = isUserOnline(receiverId);

        try {
            const newMessage = new MessageModel({
                message: sanitizedMsg,
                senderId,
                receiverId,
                status: isReceiverOnline ? "delivered" : "sent",
            });
            await newMessage.save();

            const sender = await UserModel.findById(senderId).select("name picture").lean();
            const receivedPayload = {
                _id: newMessage._id.toString(),
                message: sanitizedMsg,
                senderId,
                receiverId,
                status: newMessage.status,
                createdAt: newMessage.createdAt,
                sender: sender
                    ? {
                        _id: senderId,
                        name: sender.name,
                        picture: sender.picture,
                    }
                    : null,
            };

            if (isReceiverOnline) {
                emitToUser(receiverId, "receivedMsg", receivedPayload);
            }

            socket.emit("msgSent", newMessage._id.toString(), newMessage.status);
            emitToUser(senderId, "chatsUpdated");
            emitToUser(receiverId, "chatsUpdated");
        } catch (error) {
            console.error("Error saving message:", error.message);
        }
    });

    socket.on("setReadContext", (payload) => {
        if (!payload || typeof payload !== "object") {
            socket.activeDmUserId = null;
            socket.canMarkRead = false;
            return;
        }

        const dmUserId = typeof payload.dmUserId === "string" && payload.dmUserId.trim()
            ? payload.dmUserId.trim()
            : null;

        socket.activeDmUserId = dmUserId;
        socket.canMarkRead = dmUserId !== null && payload.canMarkRead === true;
    });

    socket.on("setGroupReadContext", (payload) => {
        if (!payload || typeof payload !== "object") {
            socket.activeGroupId = null;
            socket.canMarkGroupRead = false;
            return;
        }

        const groupId = typeof payload.groupId === "string" && payload.groupId.trim()
            ? payload.groupId.trim()
            : null;

        socket.activeGroupId = groupId;
        socket.canMarkGroupRead = groupId !== null && payload.canMarkRead === true;
    });

    // --------------- Mark Messages as Read ---------------
    socket.on("markRead", async (otherUserId) => {
        if (!otherUserId || typeof otherUserId !== "string") return;
        if (socket.canMarkRead !== true) return;
        if (socket.activeDmUserId !== otherUserId) return;
        try {
            const messages = await MessageModel.find({
                senderId: otherUserId,
                receiverId: authenticatedUserId,
                status: { $ne: "read" },
            });
            if (messages.length === 0) return;

            const msgIds = messages.map((m) => m._id.toString());
            await MessageModel.updateMany(
                { _id: { $in: msgIds } },
                { $set: { status: "read" } }
            );

            emitToUser(otherUserId, "msgRead", msgIds);
            emitToUser(otherUserId, "chatsUpdated");
            emitToUser(authenticatedUserId, "chatsUpdated");
        } catch (e) {
            console.error("markRead error:", e.message);
        }
    });

    socket.on("markGroupRead", async (groupId) => {
        if (!groupId || typeof groupId !== "string") return;
        if (socket.canMarkGroupRead !== true) return;
        if (socket.activeGroupId !== groupId) return;

        try {
            const group = await GroupModel.findOne({
                _id: groupId,
                $or: [{ admin: authenticatedUserId }, { members: authenticatedUserId }],
            }).select("_id");
            if (!group) return;

            const readState = await GroupReadStateModel.findOne({
                userId: authenticatedUserId,
                groupId,
            }).select("lastReadAt");

            const unreadQuery = {
                groupId,
                senderId: { $ne: authenticatedUserId },
            };
            if (readState?.lastReadAt) {
                unreadQuery.createdAt = { $gt: readState.lastReadAt };
            }

            const unreadCount = await GroupMessageModel.countDocuments(unreadQuery);

            await GroupReadStateModel.updateOne(
                { userId: authenticatedUserId, groupId },
                { $set: { lastReadAt: new Date() } },
                { upsert: true }
            );

            if (unreadCount > 0) {
                emitToUser(authenticatedUserId, "groupsUpdated");
            }
        } catch (e) {
            console.error("markGroupRead error:", e.message);
        }
    });

    // --------------- Friend Events ---------------
    socket.on("friendRequest", (targetUserId) => {
        emitToUser(targetUserId, "friendUpdate");
    });

    socket.on("friendAccepted", (targetUserId) => {
        emitToUser(targetUserId, "friendUpdate");
    });

    // --------------- Group Chat ---------------
    socket.on("groupMsg", async (msg, groupId) => {
        if (!msg || typeof msg !== "string" || msg.trim().length === 0) return;
        if (!groupId) return;

        const sanitizedMsg = msg.trim().substring(0, 5000);

        try {
            const user = await UserModel.findById(authenticatedUserId).select("name");
            if (!user) return;

            const group = await GroupModel.findOne({
                _id: groupId,
                $or: [{ admin: authenticatedUserId }, { members: authenticatedUserId }],
            });
            if (!group) return;

            const newMsg = new GroupMessageModel({
                groupId,
                senderId: authenticatedUserId,
                senderName: user.name,
                message: sanitizedMsg,
            });
            await newMsg.save();

            const groupMessagePayload = {
                _id: newMsg._id.toString(),
                groupId,
                senderId: authenticatedUserId,
                senderName: user.name,
                message: sanitizedMsg,
                createdAt: newMsg.createdAt,
            };

            const recipientIds = new Set([
                group.admin.toString(),
                ...group.members.map((memberId) => memberId.toString()),
            ]);

            recipientIds.forEach((memberId) => {
                if (memberId === authenticatedUserId) return;
                emitToUser(memberId, "groupMsgReceived", groupMessagePayload);
            });
            recipientIds.forEach((memberId) => {
                emitToUser(memberId, "groupsUpdated");
            });
        } catch (error) {
            console.error("Group message error:", error.message);
        }
    });

    socket.on("joinGroup", (groupId) => {
        socket.join("group:" + groupId);
    });

    socket.on("groupUpdate", (groupId) => {
        io.to("group:" + groupId).emit("groupUpdated", groupId);
    });

    socket.on("disconnect", () => {
        removeUserSocket(authenticatedUserId, socket.id);
        console.log(`User disconnected: ${authenticatedUserId}`);
    });
});

httpServer.listen(process.env.PORT, async () => {
    try {
        await connection;
        console.log("Successfully Connected to the 1337 Database.");
        console.log("Server Port: localhost:" + process.env.PORT);
        console.log("Made By Payson - github.com/paysonism");
    } catch (error) {
        console.log(error);
    }
});
