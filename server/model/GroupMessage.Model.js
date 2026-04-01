const mongoose = require("mongoose");

const groupMessageSchema = new mongoose.Schema(
    {
        groupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "group",
            required: true,
            index: true,
        },
        senderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        senderName: {
            type: String,
            required: true,
        },
        message: {
            type: String,
            required: true,
            maxlength: 5000,
        },
    },
    { timestamps: true }
);

const GroupMessageModel = mongoose.model("groupmessage", groupMessageSchema);

module.exports = { GroupMessageModel };
