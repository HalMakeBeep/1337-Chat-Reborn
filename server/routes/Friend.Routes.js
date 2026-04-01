const express = require("express");
const { UserModel } = require("../model/User.Model");
const { FriendRequestModel } = require("../model/FriendRequest.Model");
const { authenticate } = require("../middleware/Authenticate");

const friendRoutes = express.Router();
friendRoutes.use(authenticate);

function emitFriendUpdate(req, ...userIds) {
    const emitToUser = req.app.get("emitToUser");
    if (!emitToUser) return;
    [...new Set(userIds.filter(Boolean).map((id) => id.toString()))]
        .forEach((id) => emitToUser(id, "friendUpdate"));
}

// Send friend request
friendRoutes.post("/request", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (userId === req.userId.toString()) return res.status(400).json({ error: "Cannot friend yourself" });

    try {
        const existing = await FriendRequestModel.findOne({
            $or: [
                { from: req.userId, to: userId },
                { from: userId, to: req.userId },
            ],
        });

        if (existing) {
            if (existing.status === "accepted") return res.status(400).json({ error: "Already friends" });
            if (existing.status === "pending") return res.status(400).json({ error: "Request already pending" });
            if (existing.status === "declined") {
                existing.status = "pending";
                existing.from = req.userId;
                existing.to = userId;
                await existing.save();
                emitFriendUpdate(req, req.userId, userId);
                return res.json({ msg: "Friend request sent" });
            }
        }

        await new FriendRequestModel({ from: req.userId, to: userId }).save();
        emitFriendUpdate(req, req.userId, userId);
        res.status(201).json({ msg: "Friend request sent" });
    } catch (error) {
        res.status(500).json({ error: "Failed to send request" });
    }
});

// Get pending incoming requests
friendRoutes.get("/requests", async (req, res) => {
    try {
        const requests = await FriendRequestModel.find({ to: req.userId, status: "pending" })
            .populate("from", "name picture");
        res.json(requests);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch requests" });
    }
});

// Accept friend request
friendRoutes.put("/accept", async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: "requestId is required" });

    try {
        const request = await FriendRequestModel.findOne({ _id: requestId, to: req.userId, status: "pending" });
        if (!request) return res.status(404).json({ error: "Request not found" });

        request.status = "accepted";
        await request.save();

        await UserModel.updateOne({ _id: req.userId }, { $addToSet: { friends: request.from } });
        await UserModel.updateOne({ _id: request.from }, { $addToSet: { friends: req.userId } });

        emitFriendUpdate(req, req.userId, request.from);
        res.json({ msg: "Friend request accepted", friendId: request.from });
    } catch (error) {
        res.status(500).json({ error: "Failed to accept request" });
    }
});

// Decline friend request
friendRoutes.put("/decline", async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: "requestId is required" });

    try {
        const request = await FriendRequestModel.findOne({ _id: requestId, to: req.userId, status: "pending" });
        if (!request) return res.status(404).json({ error: "Request not found" });

        request.status = "declined";
        await request.save();
        emitFriendUpdate(req, req.userId, request.from);
        res.json({ msg: "Friend request declined" });
    } catch (error) {
        res.status(500).json({ error: "Failed to decline request" });
    }
});

// Remove friend
friendRoutes.delete("/remove", async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId is required" });

    try {
        await UserModel.updateOne({ _id: req.userId }, { $pull: { friends: userId } });
        await UserModel.updateOne({ _id: userId }, { $pull: { friends: req.userId } });
        await FriendRequestModel.deleteOne({
            $or: [
                { from: req.userId, to: userId },
                { from: userId, to: req.userId },
            ],
        });
        emitFriendUpdate(req, req.userId, userId);
        res.json({ msg: "Friend removed" });
    } catch (error) {
        res.status(500).json({ error: "Failed to remove friend" });
    }
});

// Get friends list
friendRoutes.get("/list", async (req, res) => {
    try {
        const user = await UserModel.findById(req.userId).populate("friends", "name picture");
        res.json(user.friends || []);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch friends" });
    }
});

module.exports = { friendRoutes };
