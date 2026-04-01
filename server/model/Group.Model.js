const mongoose = require("mongoose");

const groupSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 50,
        },
        picture: {
            type: String,
            default: "https://i.ibb.co/P4Bh7rr/default-pfp.png",
        },
        admin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        members: [{ type: mongoose.Schema.Types.ObjectId, ref: "user" }],
    },
    { timestamps: true }
);

const GroupModel = mongoose.model("group", groupSchema);

module.exports = { GroupModel };
