
import cors from "cors";
import "dotenv/config";
import express from "express";
import pool from "./src/config/database.js";
import authRouter from "./src/routes/authRoutes.js";
import roomRouter from "./src/routes/roomRoutes.js";
import hostellerRouter from "./src/routes/hostellerRoutes.js";
import feeRouter from "./src/routes/feeRoutes.js";
import reportRouter from "./src/routes/reportRoutes.js";
import apiLogger from "./src/middlewares/apiLogger.js";
import { errorHandler } from "./src/middlewares/errorHandler.js";
import { notFound } from "./src/middlewares/notFound.js";


const app = express();

const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(apiLogger);

app.get("/", (req, res) => {
  return res.status(200).json({
    message: "Server is up and running"
  });
});

// Admin Login Routes
app.use("/auth", authRouter);
app.use("/",roomRouter);
app.use("/hostellers", hostellerRouter);
app.use("/fees", feeRouter);
app.use("/reports", reportRouter);
app.use(notFound);
app.use(errorHandler);


app.listen(PORT, async () => {
  try {
    await pool.query("SELECT 1");

    console.log("DB connected successfully");
    console.log(
      `Server is running on http://localhost:${PORT}`
    );
  } catch (error) {
    console.error(
      "Database connection failed:",
      error.message
    );

    process.exit(1);
  }
});
