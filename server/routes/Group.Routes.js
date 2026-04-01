const express = require("express");
const { GroupModel } = require("../model/Group.Model");
const { GroupMessageModel } = require("../model/GroupMessage.Model");
const { GroupReadStateModel } = require("../model/GroupReadState.Model");
const { authenticate } = require("../middleware/Authenticate");

const groupRoutes = express.Router();
groupRoutes.use(authenticate);

function getGroupMemberIds(group) {
    return [...new Set([
        group.admin?.toString(),
        ...(group.members || []).map((member) => member.toString()),
    ].filter(Boolean))];
}

function emitGroupsUpdated(req, userIds) {
    const emitToUser = req.app.get("emitToUser");
    if (!emitToUser) return;

    [...new Set(userIds.filter(Boolean).map((id) => id.toString()))]
        .forEach((id) => emitToUser(id, "groupsUpdated"));
}

async function seedGroupReadStates(groupId, userIds, lastReadAt = new Date()) {
    const uniqueIds = [...new Set((userIds || []).filter(Boolean).map((id) => id.toString()))];
    await Promise.all(uniqueIds.map((id) => (
        GroupReadStateModel.updateOne(
            { userId: id, groupId },
            { $setOnInsert: { lastReadAt } },
            { upsert: true }
        )
    )));
}

// Create group
groupRoutes.post("/create", async (req, res) => {
    const { name, picture, memberIds } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ error: "Group name is required" });
    }
    try {
        const members = Array.isArray(memberIds) ? [...new Set(memberIds)] : [];
        if (!members.includes(req.userId.toString())) {
            members.push(req.userId);
        }
        const group = new GroupModel({
            name: name.trim(),
            picture: picture || undefined,
            admin: req.userId,
            members,
        });
        await group.save();
        await seedGroupReadStates(group._id, members, new Date());
        const populated = await GroupModel.findById(group._id).populate("members", "name picture").populate("admin", "name picture");
        emitGroupsUpdated(req, getGroupMemberIds(populated));
        res.status(201).json(populated);
    } catch (error) {
        res.status(500).json({ error: "Failed to create group" });
    }
});

// List groups user belongs to
groupRoutes.get("/list", async (req, res) => {
    try {
        const groups = await GroupModel.find({
            $or: [{ admin: req.userId }, { members: req.userId }],
        }).populate("members", "name picture").populate("admin", "name picture").lean();

        const summaries = await Promise.all(groups.map(async (group) => {
            const latestMessage = await GroupMessageModel.findOne({ groupId: group._id })
                .sort({ createdAt: -1 })
                .lean();

            let readState = await GroupReadStateModel.findOne({
                userId: req.userId,
                groupId: group._id,
            }).lean();

            if (!readState) {
                const baseline = latestMessage?.createdAt || group.createdAt || new Date();
                await GroupReadStateModel.updateOne(
                    { userId: req.userId, groupId: group._id },
                    { $setOnInsert: { lastReadAt: baseline } },
                    { upsert: true }
                );
                readState = { lastReadAt: baseline };
            }

            let unreadCount = 0;
            if (readState?.lastReadAt) {
                unreadCount = await GroupMessageModel.countDocuments({
                    groupId: group._id,
                    senderId: { $ne: req.userId },
                    createdAt: { $gt: readState.lastReadAt },
                });
            }

            return {
                ...group,
                lastMessage: latestMessage?.message || "",
                lastMessageAt: latestMessage?.createdAt || group.updatedAt || group.createdAt,
                lastMessageSenderId: latestMessage?.senderId ? latestMessage.senderId.toString() : null,
                lastMessageSenderName: latestMessage?.senderName || "",
                unreadCount,
            };
        }));

        summaries.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
        res.json(summaries);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch groups" });
    }
});

// Get group messages
groupRoutes.get("/messages", async (req, res) => {
    const { groupId } = req.query;
    if (!groupId) return res.status(400).json({ error: "groupId is required" });
    try {
        const group = await GroupModel.findOne({
            _id: groupId,
            $or: [{ admin: req.userId }, { members: req.userId }],
        });
        if (!group) return res.status(403).json({ error: "Not a member of this group" });

        const messages = await GroupMessageModel.find({ groupId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch messages" });
    }
});

// Add members (admin only)
groupRoutes.put("/addMembers", async (req, res) => {
    const { groupId, memberIds } = req.body;
    if (!groupId || !memberIds) return res.status(400).json({ error: "groupId and memberIds are required" });
    try {
        const group = await GroupModel.findOne({ _id: groupId, admin: req.userId }).select("admin members");
        if (!group) return res.status(403).json({ error: "Not authorized or group not found" });

        const result = await GroupModel.updateOne(
            { _id: groupId, admin: req.userId },
            { $addToSet: { members: { $each: memberIds } } }
        );
        if (result.modifiedCount === 0) return res.status(403).json({ error: "Not authorized or group not found" });

        const latestMessage = await GroupMessageModel.findOne({ groupId }).sort({ createdAt: -1 }).select("createdAt");
        await seedGroupReadStates(groupId, memberIds, latestMessage?.createdAt || new Date());

        const updatedGroup = await GroupModel.findById(groupId).select("admin members");
        emitGroupsUpdated(req, [
            ...getGroupMemberIds(updatedGroup),
            ...memberIds,
        ]);
        res.json({ msg: "Members added" });
    } catch (error) {
        res.status(500).json({ error: "Failed to add members" });
    }
});

// Remove member (admin only)
groupRoutes.put("/removeMember", async (req, res) => {
    const { groupId, memberId } = req.body;
    if (!groupId || !memberId) return res.status(400).json({ error: "groupId and memberId are required" });
    try {
        const group = await GroupModel.findOne({ _id: groupId, admin: req.userId }).select("admin members");
        if (!group) return res.status(403).json({ error: "Not authorized or group not found" });

        const result = await GroupModel.updateOne(
            { _id: groupId, admin: req.userId },
            { $pull: { members: memberId } }
        );
        if (result.modifiedCount === 0) return res.status(403).json({ error: "Not authorized or group not found" });

        await GroupReadStateModel.deleteOne({ userId: memberId, groupId });
        const updatedGroup = await GroupModel.findById(groupId).select("admin members");
        emitGroupsUpdated(req, [
            ...getGroupMemberIds(group),
            ...getGroupMemberIds(updatedGroup),
            memberId,
        ]);
        res.json({ msg: "Member removed" });
    } catch (error) {
        res.status(500).json({ error: "Failed to remove member" });
    }
});

// Leave group
groupRoutes.put("/leave", async (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: "groupId is required" });
    try {
        const group = await GroupModel.findById(groupId).select("admin members");
        if (!group) return res.status(404).json({ error: "Group not found" });

        await GroupModel.updateOne({ _id: groupId }, { $pull: { members: req.userId } });
        await GroupReadStateModel.deleteOne({ userId: req.userId, groupId });
        const updatedGroup = await GroupModel.findById(groupId).select("admin members");
        emitGroupsUpdated(req, [
            ...getGroupMemberIds(group),
            ...getGroupMemberIds(updatedGroup || { admin: null, members: [] }),
            req.userId,
        ]);
        res.json({ msg: "Left group" });
    } catch (error) {
        res.status(500).json({ error: "Failed to leave group" });
    }
});

// Delete group (admin only)
groupRoutes.delete("/delete", async (req, res) => {
    const { groupId } = req.body;
    if (!groupId) return res.status(400).json({ error: "groupId is required" });
    try {
        const group = await GroupModel.findOne({ _id: groupId, admin: req.userId }).select("admin members");
        if (!group) return res.status(403).json({ error: "Not authorized or group not found" });

        const result = await GroupModel.deleteOne({ _id: groupId, admin: req.userId });
        if (result.deletedCount === 0) return res.status(403).json({ error: "Not authorized or group not found" });
        await GroupMessageModel.deleteMany({ groupId });
        await GroupReadStateModel.deleteMany({ groupId });
        emitGroupsUpdated(req, getGroupMemberIds(group));
        res.json({ msg: "Group deleted" });
    } catch (error) {
        res.status(500).json({ error: "Failed to delete group" });
    }
});

// Update group (admin only)
groupRoutes.put("/update", async (req, res) => {
    const { groupId, name, picture } = req.body;
    if (!groupId) return res.status(400).json({ error: "groupId is required" });
    try {
        const group = await GroupModel.findOne({ _id: groupId, admin: req.userId });
        if (!group) return res.status(403).json({ error: "Not authorized or group not found" });
        if (name) group.name = name.trim();
        if (picture) group.picture = picture;
        await group.save();
        emitGroupsUpdated(req, getGroupMemberIds(group));
        res.json({ msg: "Group updated" });
    } catch (error) {
        res.status(500).json({ error: "Failed to update group" });
    }
});

module.exports = { groupRoutes };
