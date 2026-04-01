require("dotenv").config();
const { UserModel } = require("../model/User.Model");
const { BlacklistModel } = require("../model/Blacklist.Model");
const jwt = require("jsonwebtoken");

const authenticate = async (req, res, next) => {
    // Check that the Authorization header exists and is well-formed
    if (
        !req.headers.authorization ||
        !req.headers.authorization.startsWith("Bearer ")
    ) {
        return res.status(401).json({ message: "No token provided. Please login." });
    }

    const token = req.headers.authorization.split(" ")[1];

    try {
        // Check if this token has been revoked (logout / blacklist)
        const isBlocked = await BlacklistModel.findOne({ token });
        if (isBlocked) {
            return res
                .status(403)
                .json({ message: "Token has been revoked. Please login again." });
        }

        // Verify the token signature and expiry
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { userId } = decoded;

        const user = await UserModel.findById(userId).select("-password");
        if (!user) {
            return res.status(403).json({ message: "Unauthorized Access" });
        }

        // Attach user info to the request for downstream handlers
        req.user = user;
        req.userId = userId;
        next();
    } catch (error) {
        if (error.name === "TokenExpiredError")
            return res.status(401).json({ message: "Access token expired" });
        else
            return res
                .status(401)
                .json({ message: "Invalid token. Please login." });
    }
};

module.exports = { authenticate };
