import { sendErrorResponse } from "../utils/response.js";


export const notFound = (req, res) => {
  return sendErrorResponse(
    res,
    404,
    `Route not found: ${req.method} ${req.originalUrl}`
  );
};