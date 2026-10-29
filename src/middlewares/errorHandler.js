import { sendErrorResponse } from "../utils/response.js";

export const errorHandler = (
  err,
  req,
  res,
  next
) => {
  console.error("Global Error:", err);

  return sendErrorResponse(
    res,
    err.status || 500,
    err.message || "Internal Server Error"
  );
};