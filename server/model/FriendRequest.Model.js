const mongoose = require("mongoose");

const friendRequestSchema = new mongoose.Schema(
    {
        from: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        to: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        status: {
            type: String,
            enum: ["pending", "accepted", "declined"],
            default: "pending",
        },
    },
    { timestamps: true }
);

friendRequestSchema.index({ from: 1, to: 1 }, { unique: true });
friendRequestSchema.index({ to: 1, status: 1 });

const FriendRequestModel = mongoose.model("friendrequest", friendRequestSchema);

module.exports = { FriendRequestModel };
