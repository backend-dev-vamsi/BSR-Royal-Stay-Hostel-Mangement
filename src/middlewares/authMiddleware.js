import jwt from "jsonwebtoken";

import {
  sendErrorResponse,
} from "../utils/response.js";

export const verifyAdminToken = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return sendErrorResponse(res, 401, "Authentication token is required");
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET,
      {
        issuer: "private-hostel-management",
        audience: "hostel-admin"
      }
    );

    req.admin = {
      admin_id: decoded.admin_id
    };

    next();
  } catch (error) {
    return sendErrorResponse(res, 401, "Invalid or expired authentication token");
  }
};