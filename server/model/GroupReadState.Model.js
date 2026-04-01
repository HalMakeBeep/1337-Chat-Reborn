const mongoose = require("mongoose");

const groupReadStateSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
            index: true,
        },
        groupId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "group",
            required: true,
            index: true,
        },
        lastReadAt: {
            type: Date,
            default: Date.now,
        },
    },
    { timestamps: true }
);

groupReadStateSchema.index({ userId: 1, groupId: 1 }, { unique: true });

const GroupReadStateModel = mongoose.model("groupreadstate", groupReadStateSchema);

module.exports = { GroupReadStateModel };
