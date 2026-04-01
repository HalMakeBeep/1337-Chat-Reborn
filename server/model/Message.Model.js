const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
    {
        message: {
            type: String,
            required: true,
            maxlength: 3000,
        },
        senderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        receiverId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        status: {
            type: String,
            enum: ["sent", "delivered", "read"],
            default: "sent",
        },
    },
    {
        timestamps: true,
    }
);

// Compound indexes for efficient conversation queries
messageSchema.index({ senderId: 1, receiverId: 1, createdAt: 1 });
messageSchema.index({ receiverId: 1, senderId: 1, createdAt: 1 });

const MessageModel = mongoose.model("message", messageSchema);

module.exports = { MessageModel };
