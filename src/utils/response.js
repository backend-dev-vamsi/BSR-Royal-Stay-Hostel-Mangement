export function sendSuccessResponse(
  res,
  statusCode = 200,
  message = "Success",
  data = null
) {
  const response = {
    success: true,
    statusCode,
    message,
  };

  if (data) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
}

export function sendErrorResponse(
  res,
  statusCode = 500,
  message = "Internal Server Error",
  errors = null
) {
  const response = {
    success: false,
    statusCode,
    message,
  };

  if (errors) {
    response.errors = errors;
  }

  return res.status(statusCode).json(response);
}