const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 50,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            required: true,
        },
        picture: {
            type: String,
            default:
                "https://i.ibb.co/P4Bh7rr/default-pfp.png",
        },
        friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "user" }],
        settings: {
            theme: { type: String, enum: ["purple", "blue", "green", "red"], default: "purple" },
            fontSize: { type: String, enum: ["small", "medium", "large"], default: "medium" },
            notifications: { type: Boolean, default: true },
            readReceipts: { type: Boolean, default: true },
        },
    },
    {
        timestamps: true,
    }
);

const UserModel = mongoose.model("user", userSchema);

module.exports = {
    UserModel,
};
