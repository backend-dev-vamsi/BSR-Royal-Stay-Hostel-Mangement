import "dotenv/config";
import bcrypt from "bcrypt";
import pool from "../config/database.js";

async function createAdmin() {
    const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

    if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
        throw new Error(
            "ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD are required"
        );
    }

    if (ADMIN_PASSWORD.length < 10) {
        throw new Error("Admin password must be at least 10 characters");
    }

    const email = ADMIN_EMAIL.trim().toLowerCase();

    try {
        const existingAdmin = await pool.query(
            "SELECT admin_id FROM tbl_admin LIMIT 1"
        );

        if (existingAdmin.rowCount > 0) {
            throw new Error(
                "An admin account already exists. No new account created." 
            );
        }

        const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);

        await pool.query(
            `INSERT INTO tbl_admin (full_name, email, password)
             VALUES ($1, $2, $3)`,
            [ADMIN_NAME.trim(), email, hashedPassword]
        );

        console.log("Admin account created successfully.");
    } finally {
        await pool.end();
    }
}

createAdmin().catch((error) => {
    console.error("Admin setup failed:", error.message);
    process.exitCode = 1;
});