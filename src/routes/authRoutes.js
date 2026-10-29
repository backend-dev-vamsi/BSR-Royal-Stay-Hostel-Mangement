import express from "express";
import { adminLogin } from "../controllers/authController.js";
import { verifyAdminToken } from "../middlewares/authMiddleware.js";

const router = express.Router();

router.post("/login", adminLogin);

router.get("/me", verifyAdminToken, (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Admin authenticated successfully",
        data: {
            admin_id: req.admin.admin_id
        }
    });
});

export default router;